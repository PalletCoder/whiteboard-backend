const mongoose = require('mongoose');

/**
 * A Room stores a persisted whiteboard workspace (the "scene").
 * `elements` is the array of drawable elements produced by the editor and
 * `appState` holds view-level settings such as the canvas background color.
 */
const RoomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    name: {
      type: String,
      default: 'Untitled workspace',
      trim: true,
    },
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    elements: {
      type: [mongoose.Schema.Types.Mixed],
      default: [],
    },
    appState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true, minimize: false }
);

module.exports = mongoose.model('Room', RoomSchema);
