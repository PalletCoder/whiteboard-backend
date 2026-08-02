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
app.use(cors());
app.use(express.json({ limit: '25mb' }));

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 2.5e7, // 25MB to allow image elements in scene payloads
});

// REST routes
app.use('/api/auth', require('./routes/authRoutes'));
app.use('/api/rooms', require('./routes/roomRoutes'));

app.get('/', (req, res) => res.json({ status: 'ok', service: 'whiteboard-api' }));

/**
 * In-memory live sessions keyed by roomId.
 * Each session holds the latest scene (elements + appState), the set of
 * connected collaborators, the owner id (for persistence) and a debounce timer.
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

// Broadcast the end of a session and detach every socket from the room.
// `exceptId` (the host who ended it) keeps their board and is not notified.
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

// Fully add a socket to a room (host immediately, guests after approval).
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
  // Clear any pending (awaiting-approval) state first.
  const pendingRoom = socket.data.pendingRoom;
  if (pendingRoom && sessions[pendingRoom] && sessions[pendingRoom].pending) {
    delete sessions[pendingRoom].pending[socket.id];
    socket.data.pendingRoom = null;
  }

  const { roomId } = socket.data;
  if (!roomId) return;
  const session = sessions[roomId];
  if (session) {
    // The host leaving ends the session for everyone.
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
      // Forward any requests that queued up while the host was away.
      for (const [sid, pendingUser] of Object.entries(session.pending)) {
        socket.emit('join-request', { socketId: sid, user: pendingUser });
      }
      return;
    }

    // Guests need the host to approve them before joining.
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

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
