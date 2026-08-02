const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const dotenv = require('dotenv');
const cors = require('cors');

const connectDB = require('./config/db');
const Room = require('./models/Room');

dotenv.config();
connectDB();

const app = express();

const CLIENT_URL = process.env.CLIENT_URL || '*';

app.use(cors({ origin: CLIENT_URL }));
app.use(express.json({ limit: '25mb' }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { 
    origin: CLIENT_URL,
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 2.5e7, // 25MB for image payloads
});

// Health check endpoint for host monitoring
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.json({ status: 'ok', service: 'whiteboard-api' }));

// REST routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/rooms', require('./routes/roomRoutes'));

/**
 * In-memory live sessions keyed by roomId.
 */
const sessions = Object.create(null);

const COLLABORATOR_COLORS = [
  '#e64980', '#7048e8', '#1c7ed6', '#0ca678', '#f08c00',
  '#e8590c', '#ae3ec9', '#2b8a3e', '#1098ad', '#d6336c',
];

const colorForSocket = (socketId) => {
  let hash = 0;
  for (let i = 0; i < socketId.length; i += 1) {
    hash = (hash * 31 + socketId.charCodeAt(i)) & 0xffffffff;
  }
  return COLLABORATOR_COLORS[Math.abs(hash) % COLLABORATOR_COLORS.length];
};

async function persistScene(roomId) {
  const session = sessions[roomId];
  if (!session || !session.ownerId) return;
  try {
    await Room.findOneAndUpdate(
      { roomId },
      {
        $set: { elements: session.elements, appState: session.appState },
        $setOnInsert: { roomId, owner: session.ownerId, name: 'Untitled workspace' },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    console.error(`persistScene(${roomId}) error:`, err.message);
  }
}

function schedulePersist(roomId) {
  const session = sessions[roomId];
  if (!session) return;
  if (session.saveTimer) clearTimeout(session.saveTimer);
  session.saveTimer = setTimeout(() => persistScene(roomId), 1500);
}

function endSession(roomId, reason, exceptId) {
  const session = sessions[roomId];
  if (!session) return;
  const room = io.sockets.adapter.rooms.get(roomId);
  const ids = room ? Array.from(room) : [];
  for (const sid of ids) {
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    if (sid !== exceptId) {
      s.emit('session-ended', { reason: reason || 'The session was closed by the host' });
    }
    s.leave(roomId);
    s.data.roomId = null;
  }
  if (session.saveTimer) clearTimeout(session.saveTimer);
  persistScene(roomId).finally(() => {
    delete sessions[roomId];
  });
}

function admitSocket(socket, roomId, user, role) {
  const session = sessions[roomId];
  if (!session) return;
  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.data.user = user || {};
  socket.data.pendingRoom = null;
  session.collaborators[socket.id] = {
    socketId: socket.id,
    id: user && user.id,
    username: (user && user.username) || 'Anonymous',
    email: user && user.email,
    color: colorForSocket(socket.id),
    micEnabled: false,
    role,
  };
  socket.emit('joined', { role, roomId });
  socket.emit('room-scene', { elements: session.elements, appState: session.appState });
  io.to(roomId).emit('collaborators', Object.values(session.collaborators));
}

function leaveRoom(socket) {
  const pendingRoom = socket.data.pendingRoom;
  if (pendingRoom && sessions[pendingRoom] && sessions[pendingRoom].pending) {
    delete sessions[pendingRoom].pending[socket.id];
    socket.data.pendingRoom = null;
  }

  const { roomId } = socket.data;
  if (!roomId) return;
  const session = sessions[roomId];
  if (session) {
    if (session.hostSocketId === socket.id) {
      delete session.collaborators[socket.id];
      endSession(roomId, 'The host left the session');
      socket.data.roomId = null;
      return;
    }
    delete session.collaborators[socket.id];
    io.to(roomId).emit('collaborators', Object.values(session.collaborators));
    io.to(roomId).emit('collaborator-left', { socketId: socket.id });
    io.to(roomId).emit('voice-mic-state', {
      socketId: socket.id,
      username: socket.data.user?.username || 'Collaborator',
      enabled: false,
    });

    if (Object.keys(session.collaborators).length === 0) {
      if (session.saveTimer) clearTimeout(session.saveTimer);
      persistScene(roomId).finally(() => {
        delete sessions[roomId];
      });
    }
  }
  socket.leave(roomId);
  socket.data.roomId = null;
}

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join-room', async ({ roomId, user }) => {
    if (!roomId) return;
    const userId = user && user.id ? String(user.id) : null;

    let session = sessions[roomId];
    if (!session) {
      let elements = [];
      let appState = {};
      let ownerId = userId;
      try {
        const room = await Room.findOne({ roomId });
        if (room) {
          elements = room.elements || [];
          appState = room.appState || {};
          ownerId = String(room.owner);
        }
      } catch (err) {
        console.error('join-room load error:', err.message);
      }
      session = sessions[roomId] = {
        collaborators: Object.create(null),
        pending: Object.create(null),
        elements,
        appState,
        ownerId,
        hostSocketId: null,
        saveTimer: null,
      };
    }

    const isHost = !!(session.ownerId && userId && String(session.ownerId) === userId);

    if (isHost) {
      session.hostSocketId = socket.id;
      admitSocket(socket, roomId, user, 'host');
      for (const [sid, pendingUser] of Object.entries(session.pending)) {
        socket.emit('join-request', { socketId: sid, user: pendingUser });
      }
      return;
    }

    if (!session.hostSocketId || !io.sockets.sockets.get(session.hostSocketId)) {
      socket.emit('join-rejected', { reason: 'The host is not available right now' });
      return;
    }
    const pendingUser = {
      id: userId,
      username: (user && user.username) || 'Anonymous',
      email: user && user.email,
    };
    session.pending[socket.id] = pendingUser;
    socket.data.pendingRoom = roomId;
    socket.emit('awaiting-approval', { roomId });
    io.to(session.hostSocketId).emit('join-request', { socketId: socket.id, user: pendingUser });
  });

  socket.on('respond-join', ({ socketId, approved }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || session.hostSocketId !== socket.id) return;
    const pendingUser = session.pending[socketId];
    if (!pendingUser) return;
    delete session.pending[socketId];
    const guestSocket = io.sockets.sockets.get(socketId);
    if (!guestSocket) return;
    if (approved) {
      admitSocket(guestSocket, roomId, pendingUser, 'guest');
    } else {
      guestSocket.data.pendingRoom = null;
      guestSocket.emit('join-rejected', { reason: 'The host declined your request to join' });
    }
  });

  socket.on('chat-message', ({ text }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || !text) return;
    const collaborator = session.collaborators[socket.id];
    if (!collaborator) return;
    io.to(roomId).emit('chat-message', {
      id: `${Date.now()}-${socket.id}`,
      socketId: socket.id,
      username: collaborator.username,
      color: collaborator.color,
      text: String(text).slice(0, 2000),
      ts: Date.now(),
    });
  });

  socket.on('end-session', () => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || session.hostSocketId !== socket.id) return;
    endSession(roomId, 'The host ended the session', socket.id);
  });

  socket.on('scene-update', ({ elements, appState }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || !session.collaborators[socket.id]) return;
    if (Array.isArray(elements)) session.elements = elements;
    if (appState && typeof appState === 'object') session.appState = appState;

    socket.to(roomId).emit('scene-update', {
      elements: session.elements,
      appState: session.appState,
      from: socket.id,
    });
    schedulePersist(roomId);
  });

  socket.on('pointer-update', ({ x, y }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session) return;
    const collaborator = session.collaborators[socket.id];
    if (!collaborator) return;
    socket.to(roomId).emit('pointer-update', {
      socketId: socket.id,
      username: collaborator.username,
      color: collaborator.color,
      x,
      y,
    });
  });

  socket.on('voice-offer', ({ to, sdp }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || !to || !sdp || !session.collaborators[socket.id]) return;
    const target = io.sockets.sockets.get(to);
    if (!target || target.data.roomId !== roomId) return;
    target.emit('voice-offer', { from: socket.id, sdp });
  });

  socket.on('voice-answer', ({ to, sdp }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || !to || !sdp || !session.collaborators[socket.id]) return;
    const target = io.sockets.sockets.get(to);
    if (!target || target.data.roomId !== roomId) return;
    target.emit('voice-answer', { from: socket.id, sdp });
  });

  socket.on('voice-ice', ({ to, candidate }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    if (!session || !to || !candidate || !session.collaborators[socket.id]) return;
    const target = io.sockets.sockets.get(to);
    if (!target || target.data.roomId !== roomId) return;
    target.emit('voice-ice', { from: socket.id, candidate });
  });

  socket.on('voice-mic-state', ({ enabled }) => {
    const roomId = socket.data.roomId;
    const session = sessions[roomId];
    const collaborator = session && session.collaborators[socket.id];
    if (!collaborator) return;
    collaborator.micEnabled = !!enabled;
    socket.to(roomId).emit('voice-mic-state', {
      socketId: socket.id,
      username: collaborator.username,
      enabled: collaborator.micEnabled,
    });
  });

  socket.on('leave-room', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    leaveRoom(socket);
  });
});

// Environment-aware port listening
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});

// Graceful shutdown handling for containerized deploys (Render/Railway/Docker)
const gracefulShutdown = async () => {
  console.log('Shutting down server, persisting active sessions...');
  const promises = Object.keys(sessions).map((roomId) => persistScene(roomId));
  await Promise.all(promises);
  server.close(() => {
    console.log('HTTP/Socket server closed.');
    process.exit(0);
  });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

module.exports = app;