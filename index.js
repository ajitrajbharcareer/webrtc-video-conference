const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Store connected users and their rooms
const users = new Map();
const rooms = new Map();

// Middleware
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'public/uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        cb(null, `recording-${timestamp}.mp4`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    }
});

// Ensure public directory exists
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Join a room
    socket.on('join-room', (roomId, userId, userData) => {
        console.log(`User ${userId} joining room ${roomId}`);
        
        // Add user to room
        if (!rooms.has(roomId)) {
            rooms.set(roomId, new Map());
        }
        rooms.get(roomId).set(socket.id, {
            userId,
            username: userData?.username || `User-${userId}`,
            isAudioEnabled: true,
            isVideoEnabled: true,
            isScreenSharing: false
        });
        
        // Store user info
        users.set(socket.id, { 
            roomId, 
            userId,
            username: userData?.username || `User-${userId}`,
            isAudioEnabled: true,
            isVideoEnabled: true,
            isScreenSharing: false
        });
        
        socket.join(roomId);
        
        // Notify others in the room
        socket.to(roomId).emit('user-connected', {
            userId,
            username: userData?.username || `User-${userId}`,
            users: Array.from(rooms.get(roomId).values())
        });
        
        // Send current room users to the new user
        const roomUsers = Array.from(rooms.get(roomId).values());
        socket.emit('room-users', roomUsers);
        
        console.log(`User ${userId} joined room ${roomId}`);
        updateRoomUserCount(roomId);
    });

    // WebRTC signaling
    socket.on('offer', (data) => {
        socket.to(data.target).emit('offer', {
            offer: data.offer,
            sender: data.sender,
            username: data.username
        });
    });

    socket.on('answer', (data) => {
        socket.to(data.target).emit('answer', {
            answer: data.answer,
            sender: data.sender,
            username: data.username
        });
    });

    socket.on('ice-candidate', (data) => {
        socket.to(data.target).emit('ice-candidate', {
            candidate: data.candidate,
            sender: data.sender
        });
    });

    // Handle user disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        const user = users.get(socket.id);
        if (user) {
            const { roomId, userId } = user;
            
            // Remove user from room
            if (rooms.has(roomId)) {
                rooms.get(roomId).delete(socket.id);
                if (rooms.get(roomId).size === 0) {
                    rooms.delete(roomId);
                } else {
                    // Notify other users
                    socket.to(roomId).emit('user-disconnected', userId);
                    updateRoomUserCount(roomId);
                }
            }
            
            users.delete(socket.id);
        }
    });

    // Chat messages
    socket.on('send-message', (data) => {
        const user = users.get(socket.id);
        if (user) {
            const messageData = {
                userId: user.userId,
                username: user.username,
                message: data.message,
                timestamp: new Date().toISOString(),
                type: 'text'
            };
            
            socket.to(user.roomId).emit('receive-message', messageData);
            // Also send back to sender for their own display
            socket.emit('receive-message', { ...messageData, isOwn: true });
        }
    });

    // Toggle audio/video
    socket.on('toggle-audio', (enabled) => {
        const user = users.get(socket.id);
        if (user) {
            user.isAudioEnabled = enabled;
            socket.to(user.roomId).emit('user-audio-toggled', {
                userId: user.userId,
                enabled: enabled
            });
        }
    });

    socket.on('toggle-video', (enabled) => {
        const user = users.get(socket.id);
        if (user) {
            user.isVideoEnabled = enabled;
            socket.to(user.roomId).emit('user-video-toggled', {
                userId: user.userId,
                enabled: enabled
            });
        }
    });

    // Screen sharing
    socket.on('start-screen-share', () => {
        const user = users.get(socket.id);
        if (user) {
            user.isScreenSharing = true;
            socket.to(user.roomId).emit('user-started-screen-share', {
                userId: user.userId,
                username: user.username
            });
        }
    });

    socket.on('stop-screen-share', () => {
        const user = users.get(socket.id);
        if (user) {
            user.isScreenSharing = false;
            socket.to(user.roomId).emit('user-stopped-screen-share', {
                userId: user.userId
            });
        }
    });

    // Raise hand feature
    socket.on('raise-hand', () => {
        const user = users.get(socket.id);
        if (user) {
            socket.to(user.roomId).emit('user-raised-hand', {
                userId: user.userId,
                username: user.username,
                timestamp: new Date().toISOString()
            });
        }
    });

    // Change video quality
    socket.on('change-quality', (quality) => {
        const user = users.get(socket.id);
        if (user) {
            socket.to(user.roomId).emit('user-changed-quality', {
                userId: user.userId,
                quality: quality
            });
        }
    });

    // Leave room
    socket.on('leave-room', () => {
        const user = users.get(socket.id);
        if (user) {
            const { roomId, userId } = user;
            
            socket.leave(roomId);
            socket.to(roomId).emit('user-disconnected', userId);
            
            if (rooms.has(roomId)) {
                rooms.get(roomId).delete(socket.id);
                if (rooms.get(roomId).size === 0) {
                    rooms.delete(roomId);
                } else {
                    updateRoomUserCount(roomId);
                }
            }
            
            users.delete(socket.id);
        }
    });
});

function updateRoomUserCount(roomId) {
    if (rooms.has(roomId)) {
        const userCount = rooms.get(roomId).size;
        io.to(roomId).emit('room-user-count', { roomId, userCount });
    }
}

// Upload endpoint
app.post('/upload', upload.single('video'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No video file received' });
        }

        console.log('Video saved successfully:', req.file.filename);
        res.json({ 
            message: 'Video saved successfully',
            filename: req.file.filename,
            path: `/uploads/${req.file.filename}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Failed to save video' });
    }
});

// Get room info
app.get('/api/rooms/:roomId', (req, res) => {
    const roomId = req.params.roomId;
    const room = rooms.get(roomId);
    if (room) {
        res.json({ 
            userCount: room.size,
            users: Array.from(room.values())
        });
    } else {
        res.json({ userCount: 0, users: [] });
    }
});

// Get all active rooms
app.get('/api/rooms', (req, res) => {
    const roomsInfo = {};
    rooms.forEach((users, roomId) => {
        roomsInfo[roomId] = {
            userCount: users.size,
            users: Array.from(users.values())
        };
    });
    res.json(roomsInfo);
});

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve recordings
app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename;
    const videoPath = path.join(__dirname, 'public', 'uploads', filename);
    
    if (fs.existsSync(videoPath)) {
        res.sendFile(videoPath);
    } else {
        res.status(404).json({ error: 'Recording not found' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 WebRTC Video Conferencing server running on port ${PORT}`);
    console.log(`📱 Access the application at: http://localhost:${PORT}`);
    console.log(`🔧 API endpoints available at: http://localhost:${PORT}/api/rooms`);
});