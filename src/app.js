const express = require('express')

const app = express()
const https = require('httpolyglot')
const fs = require('fs')
const mediasoup = require('mediasoup')
const config = require('./config')
const path = require('path')
const Room = require('./Room')
const Peer = require('./Peer')
const cors = require('cors')

const options = {
  //key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
  //cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8')
  ca: fs.readFileSync('/var/www/html/data/certbot/conf/live/buskontest.gq-0001/fullchain.pem'),
  key: fs.readFileSync('/var/www/html/data/certbot/conf/live/buskontest.gq-0001/privkey.pem'),
  cert: fs.readFileSync('/var/www/html/data/certbot/conf/live/buskontest.gq-0001/cert.pem')
}

const httpsServer = https.createServer(options, app)
const io = require('socket.io')(httpsServer, { 'pingInterval': 55000 }) //약 5~6초간격임 핑퐁ㅎㅎ 95000하니까 너무 길었음

app.use(express.static(path.join(__dirname, '..', 'public')))
app.use(cors({ credentials: true, origin: false }));
app.all('/*', function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "X-Requested-With");
  next();
});

httpsServer.listen(config.listenPort, () => {
  console.log('Listening on https://' + config.listenIp + ':' + config.listenPort)
})

// all mediasoup workers
let workers = []
let nextMediasoupWorkerIdx = 0

/**
 * roomList
 * {
 *  room_id: Room {
 *      id:
 *      router:
 *      peers: {
 *          id:,
 *          name:,
 *          master: [boolean],
 *          transports: [Map],
 *          producers: [Map],
 *          consumers: [Map],
 *          rtpCapabilities:
 *      }
 *  }
 * }
 */
let roomList = new Map()

  ; (async () => {
    await createWorkers()
  })()

async function createWorkers() {
  let { numWorkers } = config.mediasoup

  for (let i = 0; i < numWorkers; i++) {
    let worker = await mediasoup.createWorker({
      logLevel: config.mediasoup.worker.logLevel,
      logTags: config.mediasoup.worker.logTags,
      rtcMinPort: config.mediasoup.worker.rtcMinPort,
      rtcMaxPort: config.mediasoup.worker.rtcMaxPort
    })

    worker.on('died', () => {
      console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid)
      setTimeout(() => process.exit(1), 2000)
    })
    workers.push(worker)

    // log worker resource usage
    /*setInterval(async () => {
            const usage = await worker.getResourceUsage();

            console.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
        }, 120000);*/
  }
}

io.on('connection', (socket) => {

  //커넥션 뭐든 연결될때마다 찍어보는 로그
  console.log("new request...");

  socket.on('createRoom', async ({ room_id, name }, callback) => {
    if (roomList.has(room_id)) {
      callback('already exists')
    } else {
      console.log('Created room', { room_id: room_id })
      let worker = await getMediasoupWorker()
      roomList.set(room_id, new Room(room_id, worker, io, socket.id, name))
      callback(room_id)
    }
  })

  socket.on('join', ({ room_id, name, nickname }, cb) => {

    console.log('User joined', {
      room_id: room_id,
      name: name
    })

    if (!roomList.has(room_id)) {
      return cb({
        error: 'Room does not exist'
      })
    }

    if (roomList.get(room_id).shouldDestroyed) {
      //공연자가 10초 뒤 재접속 한경우뿐임
      roomList.delete(room_id)
      return cb({
        error: 'Room already destroyed'
      })
    } else {
      //네트워크 변경후 다시 fetchSocket으로 들어옴
      var room = roomList.get(room_id)
      var peers = room.getPeers()
      peers.forEach((peer) => {
        if (peer.name == name) {
          room.removePeer(peer.id)
        }//이미있던사람이였던거임 네트워크 변경으로 재연결한거
      })
      room.addPeer(new Peer(socket.id, name, nickname))
      socket.room_id = room_id
      //만약에 공연자가 추가된거면 1초 단위로 핑퐁보내다가 핑퐁안되면 네트워크 끊긴걸로 간주고하고 startTimeOut 10초 세고 방 폭파한다
      if (room.artistName == name) {
        room.artistId = socket.id//소켓아이디는업데이트해줘야함
      }

      cb(roomList.get(room_id).toJson())
    }

  })

  socket.on('getProducers', () => {
    if (!roomList.has(socket.room_id)) return
    console.log('Get producers', { name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

    // send all the current producer to newly joined member
    let producerList = roomList.get(socket.room_id).getProducerListForPeer()
    let participantList = roomList.get(socket.room_id).getParticipantListForPeer()

    socket.emit('newProducers', producerList)
    //은진추가 통째로 참가자들 넘겨준 처음에 들어갔을때
    socket.emit('newParticipants', participantList)
  })

  socket.on('getRouterRtpCapabilities', (_, callback) => {
    console.log('Get RouterRtpCapabilities', {
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    try {
      callback(roomList.get(socket.room_id).getRtpCapabilities())
    } catch (e) {
      callback({
        error: e.message
      })
    }
  })

  socket.on('createWebRtcTransport', async (_, callback) => {
    console.log('Create webrtc transport', {
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    try {
      const { params } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id)

      callback(params)
    } catch (err) {
      console.error(err)
      callback({
        error: err.message
      })
    }
  })

  socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
    console.log('Connect transport', { name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}` })

    if (!roomList.has(socket.room_id)) return
    await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters)

    callback('success')
  })

  socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
    if (!roomList.has(socket.room_id)) {
      return callback({ error: 'not is a room' })
    }

    let producer_id = await roomList.get(socket.room_id).produce(socket.id, producerTransportId, rtpParameters, kind)

    console.log('Produce', {
      type: `${kind}`,
      name: `${roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
      id: `${producer_id}`
    })

    callback({
      producer_id
    })
  })

  socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
    //TODO null handling
    let params = await roomList.get(socket.room_id).consume(socket.id, consumerTransportId, producerId, rtpCapabilities)

    console.log('Consuming', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`,
      producer_id: `${producerId}`,
      consumer_id: `${params.id}`
    })

    callback(params)
  })

  socket.on('resume', async (data, callback) => {
    await consumer.resume()
    callback()
  })

  socket.on('getMyRoomInfo', (_, cb) => {
    cb(roomList.get(socket.room_id).toJson())
  })

  socket.on('disconnect', () => {
    console.log('Disconnect', { // lte연결끊어지고나서한참뒤에나저disconnect뜸, 와이파이lete변경은 빠르게 하는거 알아서 처리해주나?
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    if (!socket.room_id) return
    if (roomList.has(socket.room_id)) {//은진예외처리 공연자 방폭파후 disconnect할떄
      //만약 공연자가 나간다면 10초 뒤에도 안들어온다면  방을 폭파해야함
      console.log(roomList.get(socket.room_id).artistName, roomList.get(socket.room_id).artistId, socket.id)
      if (roomList.get(socket.room_id).artistId == socket.id) {
        //이미 끊기고 10초 지난거임
        roomList.get(socket.room_id).timeoutEndRoom(socket.id) // 10초 방폭파하고 다시 접속했을때 공연자도 나가게 만들기위함
      }
      //관객공연자다 removePeer하는거임
      roomList.get(socket.room_id).removePeer(socket.id)
    }
  })

  socket.on('producerClosed', ({ producer_id }) => {
    console.log('Producer close', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })
    //은진예외처리 (공연자가 와이파이 끄고 10초 지난 후 이미 producerClosed했는데 접속시 무조건 leaveRoom=rc.exit하기떄문에)
    if (roomList.has(socket.room_id)) {
      roomList.get(socket.room_id).closeProducer(socket.id, producer_id)
    }

  })

  socket.on('exitRoom', async (_, callback) => {
    console.log('Exit room', {
      name: `${roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id) && roomList.get(socket.room_id).getPeers().get(socket.id).name}`
    })

    if (!roomList.has(socket.room_id)) {
      callback({
        error: 'not currently in a room'
      })
      return
    }

    //은진추가 공연자일경우 알려주기
    if (roomList.get(socket.room_id).artistId == socket.id) {
      console.log("공연자가 exitRoom")
      roomList.get(socket.room_id).broadCast(socket.id, 'endRoom', null)
      await roomList.get(socket.room_id).removeAllPeer()
    } else {
      console.log("관객이 exitRoom")
      // close transports
      await roomList.get(socket.room_id).removePeer(socket.id)
    }

    if (roomList.get(socket.room_id).getPeers().size === 0 && !roomList.get(socket.room_id).shouldDestroyed) {//true일땐 자동으로 없애주면 안됨 공연자가 다시 접속했을떄 방없애야함
      roomList.delete(socket.room_id)
    }
    socket.room_id = null
    callback('successfully exited room')
  })

  //은진추가
  socket.on('changeRoomId', ({ newId }) => {
    console.log('changeRoomId', {
      name: `${socket.room_id && newId}`
    })
    //var copy_object = Object.assign({}, roomList.get(socket.room_id) )//카피해서 복제
    roomList.set(newId, roomList.get(socket.room_id))//기존 id거를 newid로 바꿔줌 map에서
    roomList.delete(socket.room_id) //기존id객체를 삭제함 (객체남아있나?clone해야하나?)
    roomList.get(newId).changeId(newId)//새로운id 객체 내부 id 바꿔줌
    socket.room_id = newId//소켓의방id도바꿔줌
  })

  //은진추가
  socket.on('expulsion', ({ name }) => {
    console.log('expulsion', {
      name: `${name}`
    })

    //강퇴당한사람한테알려주고 내부적으로 없애기
    roomList.get(socket.room_id).getPeers().forEach((peer) => {
      if (peer.name == name) {
        roomList.get(socket.room_id).send(peer.id, 'expulsionGet', null) // isin알아서 바뀌면서 알아서 leaveRoom함
      }
    })
  })

  //은진추가 닉네임 변경
  socket.on('changeNickname', ({ nickname }) => {
    console.log('changeNickname', {
      name: `${nickname}`
    })
    roomList.get(socket.room_id).getPeers().get(socket.id).nickname = nickname
    roomList.get(socket.room_id).broadCast(socket.id, 'changeNickname', {
      name: roomList.get(socket.room_id).getPeers().get(socket.id).name,
      nickname: nickname,
    })
  })

  //은진추가 강제종료 방
  socket.on('stopRoom', ({ room_id, alert_index }) => {
    console.log('stopRoom', room_id, alert_index)
    if (!roomList.has(room_id)) {
      io.to(socket.id).emit('stopRoomReturn', '공연장 없음')
      console.log('not currently in a room')
      return
    } else {
      io.to(socket.id).emit('stopRoomReturn', '공연장 강제종료 성공')
      roomList.get(room_id).send(roomList.get(room_id).artistId, 'stopRoom', alert_index)
    }
  })

  //은진추가 방정보변경
  socket.on('changeRoomInfo', ({ roomInfo }) => {
    console.log('changeRoomInfo', {
      roomInfo: `${roomInfo}`
    })
    //roomList.get(socket.room_id).getPeers().get(socket.id).nickname = nickname 룸 정보(이름이나 url등)는 저장하지 않믕
    roomList.get(socket.room_id).broadCast(socket.id, 'changeRoomInfo', {
      roomInfo: roomInfo,
    })
  })





})

// TODO remove - never used?
function room() {
  return Object.values(roomList).map((r) => {
    return {
      router: r.router.id,
      peers: Object.values(r.peers).map((p) => {
        return {
          name: p.name
        }
      }),
      id: r.id
    }
  })
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
  const worker = workers[nextMediasoupWorkerIdx]

  if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0

  return worker
}
