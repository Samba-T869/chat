const socket = io({
    transports: ['websocket', 'polling'],
    withCredentials: true
});

const chatBox = document.getElementById('chat-box');
const messagesDiv = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const typingIndicator = document.getElementById('typing-indicator');
const userCount = document.getElementById('user-count');
const logoutBtn = document.getElementById('logout-btn');

let currentUsername = '';
let isTyping = false;
let typingTimeout = null;

// Check authentication
async function checkAuth() {
    try {
        const response = await fetch('/api/check-auth', {
            credentials: 'include'
        });
        const data = await response.json();
        
        if (!data.authenticated) {
            window.location.href = '/login.html';
            return;
        }
        
        currentUsername = data.username;
        document.getElementById('username-display').textContent = currentUsername;
        messageInput.disabled = false;
        sendBtn.disabled = false;
        
        initializeSocket();
    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/login.html';
    }
}

function initializeSocket() {
    socket.on('connect', () => {
        console.log('Socket connected');
    });

    socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
    });

    socket.on('previous messages', (messages) => {
        messages.forEach(msg => displayMessage(msg, false));
        scrollToBottom();
    });

    socket.on('receive message', (data) => {
        displayMessage(data, false);
        scrollToBottom();
    });

    socket.on('user typing', (username) => {
        if (username !== currentUsername) {
            typingIndicator.textContent = `${username} is typing...`;
        }
    });

    socket.on('stop typing', () => {
        typingIndicator.textContent = '';
    });

    socket.on('error', (error) => {
        alert(error);
    });
}

function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    socket.emit('send message', {
        message: message
    });

    const data = {
        username: currentUsername,
        message: message,
        timestamp: new Date().toISOString()
    };
    displayMessage(data, true);
    messageInput.value = '';
    scrollToBottom();
    
    if (isTyping) {
        socket.emit('stop typing');
        isTyping = false;
    }
}

function displayMessage(data, isOwn) {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${isOwn ? 'user' : 'other'}`;
    
    const timestamp = data.timestamp ? new Date(data.timestamp) : new Date();
    const timeStr = timestamp.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit' 
    });
    
    messageDiv.innerHTML = `
        <div class="username">${data.username}</div>
        <div>${data.message}</div>
        <span class="time">${timeStr}</span>
    `;
    
    messagesDiv.appendChild(messageDiv);
}

messageInput.addEventListener('input', () => {
    if (messageInput.value.length > 0 && !isTyping) {
        isTyping = true;
        socket.emit('typing');
    } else if (messageInput.value.length === 0 && isTyping) {
        isTyping = false;
        socket.emit('stop typing');
    }
    
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
        if (isTyping) {
            isTyping = false;
            socket.emit('stop typing');
        }
    }, 2000);
});

messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

sendBtn.addEventListener('click', sendMessage);

function scrollToBottom() {
    chatBox.scrollTop = chatBox.scrollHeight;
}

logoutBtn.addEventListener('click', async () => {
    try {
        await fetch('/api/logout', { 
            method: 'POST',
            credentials: 'include'
        });
        window.location.href = '/login.html';
    } catch (error) {
        console.error('Logout failed:', error);
    }
});

checkAuth();