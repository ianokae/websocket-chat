const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8086 });

wss.on('connection', ws => {
    console.log('Client connected');

    ws.on('message', message => {
        console.log('Received message:', message.toString());

        // Broadcast the message to all connected clients
        wss.clients.forEach(client => {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });

    ws.on('close', () => {
        console.log('Client disconnected');
    });

    ws.on('error', error => {
        console.error('WebSocket error:', error);
    });

    // Send a welcome message to the newly connected client
    ws.send('Welcome to the simple chat!');
});

console.log('WebSocket server started on port 8086');
