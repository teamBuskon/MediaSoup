const config = require('./config')
//this.id랑 socket.room_id가 변경되어야함
//id가 PK와 같다고 보면 됨 여기에선
module.exports = class Room {
  constructor(room_id, worker, io, socket_id, name) {
    this.id = room_id
    //은진추가 파라미터랑 같이
    this.artistId = socket_id //주인의 소켓아이디
    this.artistName = name //주인의 PK임
    this.timeoutObject = null // timeout 객체임 (공연자 나갔을때 네트워크 변경으로 시작함 10초세는 친구)
    this.shouldDestroyed = false // 10초 지나면 없어져야할 객체임을 나타내는 변수 (공연자가 재접속할때 true면 방없애고 나도 공연장 나감 )

    const mediaCodecs = config.mediasoup.router.mediaCodecs
    worker
      .createRouter({
        mediaCodecs
      })
      .then(
        function (router) {
          this.router = router
        }.bind(this)
      )

    this.peers = new Map()
    this.io = io
  }

  //은진추가 함수
  changeId(room_id) {
    //reday_userPK에서 -> roomPK로
    this.id = room_id
  }



  //은진추가 공연자 네트워크 변경으로 나갔을때 호출됨
  timeoutEndRoom(socket_id){
    console.log("timeoutEndRoom"+socket_id)
    this.shouldDestroyed = true
    this.broadCast(socket_id, 'endRoom',null)
    this.removeAllPeer()
  }

  addPeer(peer) {
    this.peers.set(peer.id, peer)
    //은진추가
    this.broadCast(peer.id, 'addPeer',//나빼고 새로움사람 들어왔다 알려주기
      {
        id: peer.id,
        name: peer.name,
        nickname: peer.nickname,
      }
    )
    //만약 나갔던 공연자가 다시 10초안에들어옴
    if (this.artistName == peer.name){
      clearTimeout(this.timeoutObject);
    }
  }

  getProducerListForPeer() {
    let producerList = []
    this.peers.forEach((peer) => {
      peer.producers.forEach((producer) => {
        producerList.push({
          producer_id: producer.id
        })
      })
    })
    return producerList
  }

  //은진추가 관객목록넘겨주기
  getParticipantListForPeer() {
    let participantList = []
    this.peers.forEach((peer) => {
      participantList.push({
        id: peer.id,
        name: peer.name,
        nickname: peer.nickname
      })
    })
    return participantList
  }

  getRtpCapabilities() {
    return this.router.rtpCapabilities
  }

  async createWebRtcTransport(socket_id) {
    const { maxIncomingBitrate, initialAvailableOutgoingBitrate } = config.mediasoup.webRtcTransport

    const transport = await this.router.createWebRtcTransport({
      listenIps: config.mediasoup.webRtcTransport.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate
    })
    if (maxIncomingBitrate) {
      try {
        await transport.setMaxIncomingBitrate(maxIncomingBitrate)
      } catch (error) {}
    }

    transport.on(
      'dtlsstatechange',
      function (dtlsState) {
        if (dtlsState === 'closed') {
          console.log('Transport close', { name: this.peers.get(socket_id).name })
          transport.close()
        }
      }.bind(this)
    )

    transport.on('close', () => {
      console.log('Transport close', { name: this.peers.get(socket_id).name })
    })

    console.log('Adding transport', { transportId: transport.id })
    this.peers.get(socket_id).addTransport(transport)
    return {
      params: {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters
      }
    }
  }

  async connectPeerTransport(socket_id, transport_id, dtlsParameters) {
    if (!this.peers.has(socket_id)) return

    await this.peers.get(socket_id).connectTransport(transport_id, dtlsParameters)
  }

  async produce(socket_id, producerTransportId, rtpParameters, kind) {
    // handle undefined errors
    return new Promise(
      async function (resolve, reject) {
        let producer = await this.peers.get(socket_id).createProducer(producerTransportId, rtpParameters, kind)
        resolve(producer.id)
        this.broadCast(socket_id, 'newProducers', [
          {
            producer_id: producer.id,
            producer_socket_id: socket_id
          }
        ])
      }.bind(this)
    )
  }

  async consume(socket_id, consumer_transport_id, producer_id, rtpCapabilities) {
    // handle nulls
    if (
      !this.router.canConsume({
        producerId: producer_id,
        rtpCapabilities
      })
    ) {
      console.error('can not consume')
      return
    }

    let { consumer, params } = await this.peers
      .get(socket_id)
      .createConsumer(consumer_transport_id, producer_id, rtpCapabilities)

    consumer.on(
      'producerclose',
      function () {
        console.log('Consumer closed due to producerclose event', {
          name: `${this.peers.get(socket_id).name}`,
          consumer_id: `${consumer.id}`
        })
        this.peers.get(socket_id).removeConsumer(consumer.id)
        // tell client consumer is dead
        this.io.to(socket_id).emit('consumerClosed', {
          consumer_id: consumer.id
        })
      }.bind(this)
    )

    return params
  }

  async removePeer(socket_id) {
    //은진추가&변경 나빼고 떠났다 알려주기
    if (!this.peers.has(socket_id)) return
    let peer = this.peers.get(socket_id)
    this.broadCast(socket_id, 'removePeer',{
          id: peer.id,
          name: peer.name,
          nickname: peer.nickname,
    })
    peer.close()
    this.peers.delete(socket_id)
  }


  //은진추가 공연자가 방나갈때 방폭파용
  async removeAllPeer() {
    this.peers.forEach((peer) => {
      peer.close()
      this.peers.delete(peer.id)
    })
  }

  closeProducer(socket_id, producer_id) {
    this.peers.get(socket_id).closeProducer(producer_id)
  }

  broadCast(socket_id, name, data) {
    //나빼고 다보내는거임
    for (let otherID of Array.from(this.peers.keys()).filter((id) => id !== socket_id)) {
      this.send(otherID, name, data)
    }
  }

  send(socket_id, name, data) {
    this.io.to(socket_id).emit(name, data)
  }

  getPeers() {
    return this.peers
  }

  toJson() {
    return {
      id: this.id,
      peers: JSON.stringify([...this.peers])
    }
  }
}
