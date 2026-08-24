const socket = io();

const chatBox = document.getElementById('chat-box');
const messagesDiv = document.getElementById('messages');
const usernameInput = document.getElementById('username');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const typingIndicator = document.getElementById('typing-indicator');
const userCount = document.getElementById('user-count');

let currentUsername = '';
let isTyping = false;
let typingTimeout = null;

// Load previous messages on connection
socket.on('previous messages', (messages) => {
    messages.forEach(msg => displayMessage(msg, false));
    scrollToBottom();
});

// Receive new message
socket.on('receive message', (data) => {
    displayMessage(data, false);
    scrollToBottom();
    if (data.username !== currentUsername) {
        // Play notification sound if needed
    }
});

// Display typing indicator
socket.on('user typing', (username) => {
    if (username !== currentUsername) {
        typingIndicator.textContent = `${username} is typing...`;
    }
});

socket.on('stop typing', () => {
    typingIndicator.textContent = '';
});

// Error handling
socket.on('error', (error) => {
    alert(error);
});

// Username validation
usernameInput.addEventListener('change', () => {
    const name = usernameInput.value.trim();
    if (name.length > 0) {
        currentUsername = name;
        messageInput.disabled = false;
        sendBtn.disabled = false;
        messageInput.placeholder = `Type a message, ${name}...`;
        socket.emit('user joined', name);
    } else {
        messageInput.disabled = true;
        sendBtn.disabled = true;
        messageInput.placeholder = 'Enter your name first';
    }
});

// Send message
function sendMessage() {
    const message = messageInput.value.trim();
    if (!message || !currentUsername) return;

    socket.emit('send message', {
        username: currentUsername,
        message: message
    });

    // Display own message immediately
    const data = {
        username: currentUsername,
        message: message,
        timestamp: new Date().toISOString()
    };
    displayMessage(data, true);
    messageInput.value = '';
    scrollToBottom();
    
    // Stop typing indicator
    if (isTyping) {
        socket.emit('stop typing');
        isTyping = false;
    }
}

// Display message in UI
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

// Typing indicator
messageInput.addEventListener('input', () => {
    if (messageInput.value.length > 0 && !isTyping) {
        isTyping = true;
        socket.emit('typing', currentUsername);
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

// Send on Enter key
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        sendMessage();
    }
});

sendBtn.addEventListener('click', sendMessage);

// Scroll to bottom
function scrollToBottom() {
    chatBox.scrollTop = chatBox.scrollHeight;
}

// Load previous messages from API on page load
async function loadPreviousMessages() {
    try {
        const response = await fetch('/api/messages');
        const messages = await response.json();
        messages.forEach(msg => displayMessage(msg, false));
        scrollToBottom();
    } catch (error) {
        console.error('Error loading messages:', error);
    }
}

// Initialize
loadPreviousMessages();

// Update user count (optional)
socket.on('user count', (count) => {
    userCount.textContent = `Users: ${count}`;
});