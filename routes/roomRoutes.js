const express = require('express');
const router = express.Router();
const auth = require('../middleware/auth');
const {
  createRoom,
  listRooms,
  getRoom,
  saveScene,
  deleteRoom,
} = require('../controllers/roomController');

// All workspace routes require authentication
router.use(auth);

router.post('/', createRoom);
router.get('/', listRooms);
router.get('/:roomId', getRoom);
router.put('/:roomId/scene', saveScene);
router.delete('/:roomId', deleteRoom);

module.exports = router;
