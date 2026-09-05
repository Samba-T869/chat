let socket = null;

const chatBox = document.getElementById('chat-box');
const messagesDiv = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const typingIndicator = document.getElementById('typingIndicator');
const userCount = document.getElementById('user-count');
const onlineCount = document.getElementById('onlineCount');
const logoutBtn = document.getElementById('logout-btn');
const userListDiv = document.getElementById('users');

let currentUsername = '';
let name = "";
let status = "";
let isTyping = false;
let typingTimeout = null;
let users = 0;
let online = 0;

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
        document.getElementById('online-count').textContent = '0 Online';
        document.getElementById('username-display').textContent = currentUsername;
        messageInput.disabled = false;
        sendBtn.disabled = false;

        // Load stored messages from PostgreSQL
        await loadMessages();

        initializeSocket();
        await fetchOnlineUsers();

    } catch (error) {
        console.error('Auth check failed:', error);
        window.location.href = '/login.html';
    }
}

function initializeSocket() {
    socket = io({
        transports: ['websocket', 'polling'],
        withCredentials: true
    });

    socket.on('connect', () => {
        console.log('🍀Socket connected', socket.id);
    });

    socket.on('connect_error', (error) => {
        console.error('📌Socket connection error:', error);
    });

    socket.on('online users', (users) => {
        updateUserList(users);
    });

    socket.on('previous messages', (messages) => {
        messages.forEach(msg => displayMessage(msg, false));
        scrollToBottom();
    });

    socket.on('receive message', (data) => {
        const isOwn = data.username === currentUsername;
        displayMessage(data, isOwn);
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

async function fetchOnlineUsers() {
    try {
        const response = await fetch('/api/online-users', {
            credentials: 'include'
        });
        if (response.ok) {
            const users = await response.json();
            updateUserList(users);
        }
    } catch (error) {
        console.error('Failed to fetch online users:', error);
    }
}

// Replace the updateUserList function with this:
function updateUserList(users) {
    // Update online count
    const onlineCountElement = document.getElementById('online-count');
    if (onlineCountElement) {
        const online = users.filter(u => u.status === 'online').length;
        onlineCountElement.textContent = `${online} Online`;
    }

    // If there's a user list div, display users
    if (userListDiv) {
        if (users.length === 0) {
            userListDiv.innerHTML = '<div class="no-users">No users online</div>';
            return;
        }

        let html = '<h3>Online Users</h3>';
        users.forEach(user => {
            const isCurrentUser = user.username === currentUsername;
            html += `
                <div class="user-item ${isCurrentUser ? 'current-user' : ''}">
                    <span class="user-status online"></span>
                    ${user.username} ${isCurrentUser ? '(you)' : ''}
                </div>
            `;
        });
        userListDiv.innerHTML = html;
    }
}

async function loadMessages() {
    try {
        const response = await fetch('/api/messages', {
            method: 'GET',
            credentials: 'include'
        });

        if (!response.ok) {
            throw new Error(`Failed to load messages: ${response.status}`);
        }

        const messages = await response.json();

        messagesDiv.innerHTML = '';

        messages.forEach(msg => {
            displayMessage(
                msg,
                msg.username === currentUsername
            );
        });

        scrollToBottom();

        console.log('Messages loaded:', messages.length);
    } catch (error) {
        console.error('Failed to fetch messages:', error);
    }
}

function sendMessage() {
    const message = messageInput.value.trim();

    if (!message) return;

    if (!socket || !socket.connected) {
        console.error('Socket is not connected');
        return;
    }

    socket.emit('send message', {
        message: message
    });

    messageInput.value = '';

    if (isTyping) {
        socket.emit('stop typing');
        isTyping = false;
    }
}

function displayMessage(data, isOwn) {
    const messageDiv = document.createElement('div');
    // Use 'sent' for own messages, 'received' for others
    messageDiv.className = `message ${isOwn ? 'sent' : 'received'}`;
    
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