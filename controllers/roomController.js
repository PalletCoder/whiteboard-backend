const crypto = require('crypto');
const Room = require('../models/Room');

const generateRoomId = () => crypto.randomBytes(10).toString('hex');

// @route   POST /api/rooms
// @desc    Create a new workspace owned by the current user
// @access  Private
exports.createRoom = async (req, res) => {
  try {
    const { name, roomId, elements, appState } = req.body;
    const id = roomId || generateRoomId();

    const existing = await Room.findOne({ roomId: id });
    if (existing) {
      return res.status(400).json({ message: 'Room already exists' });
    }

    const room = await Room.create({
      roomId: id,
      name: name || 'Untitled workspace',
      owner: req.user._id,
      elements: Array.isArray(elements) ? elements : [],
      appState: appState && typeof appState === 'object' ? appState : {},
    });

    res.status(201).json(room);
  } catch (err) {
    console.error('createRoom error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
};

// @route   GET /api/rooms
// @desc    List workspaces owned by the current user
// @access  Private
exports.listRooms = async (req, res) => {
  try {
    const rooms = await Room.find({ owner: req.user._id })
      .sort({ updatedAt: -1 })
      .select('roomId name createdAt updatedAt');
    res.json(rooms);
  } catch (err) {
    console.error('listRooms error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
};

// @route   GET /api/rooms/:roomId
// @desc    Load a workspace scene (any authenticated user with the link)
// @access  Private
exports.getRoom = async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    res.json(room);
  } catch (err) {
    console.error('getRoom error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
};

// @route   PUT /api/rooms/:roomId/scene
// @desc    Save (upsert) a workspace scene
// @access  Private
exports.saveScene = async (req, res) => {
  try {
    const { elements, appState, name } = req.body;

    const set = {};
    if (Array.isArray(elements)) set.elements = elements;
    if (appState && typeof appState === 'object') set.appState = appState;
    if (typeof name === 'string' && name.trim()) set.name = name.trim();

    const room = await Room.findOneAndUpdate(
      { roomId: req.params.roomId },
      { $set: set, $setOnInsert: { roomId: req.params.roomId, owner: req.user._id } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    res.json(room);
  } catch (err) {
    console.error('saveScene error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
};

// @route   DELETE /api/rooms/:roomId
// @desc    Delete a workspace (owner only)
// @access  Private
exports.deleteRoom = async (req, res) => {
  try {
    const room = await Room.findOne({ roomId: req.params.roomId });
    if (!room) {
      return res.status(404).json({ message: 'Room not found' });
    }
    if (String(room.owner) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Not authorized' });
    }
    await room.deleteOne();
    res.json({ message: 'Workspace deleted' });
  } catch (err) {
    console.error('deleteRoom error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
};
