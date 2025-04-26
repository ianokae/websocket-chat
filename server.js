const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8086 });

// Store clients with their associated usernames: { ws => username }
const clients = new Map();

console.log('WebSocket server started on port 8086');

wss.on('connection', (ws) => {
    console.log('Client connected (pending identification)');

    ws.on('message', (message) => {
        let parsedMessage;
        try {
            parsedMessage = JSON.parse(message.toString());
            console.log('Received:', parsedMessage);
        } catch (error) {
            console.error('Failed to parse message or invalid message format:', message.toString());
            safeSend(ws, { type: 'system', text: 'Error: Invalid message format.' });
            return;
        }

        const currentUsername = clients.get(ws); // Get username associated with this ws connection

        switch (parsedMessage.type) {
            case 'setUsername':
                const newUsername = parsedMessage.username?.trim();
                if (!newUsername) {
                    console.log('Invalid username received');
                    safeSend(ws, { type: 'system', text: 'Error: Invalid username provided.' });
                    ws.close(1008, "Invalid username"); // Close connection
                    return;
                }

                // Check if username is already taken
                let isTaken = false;
                for (const username of clients.values()) {
                    if (username && username.toLowerCase() === newUsername.toLowerCase()) { // Case-insensitive check
                        isTaken = true;
                        break;
                    }
                }

                if (isTaken) {
                     console.log(`Username "${newUsername}" is already taken.`);
                     // Send specific error message the client can react to
                     safeSend(ws, { type: 'system', text: `Error: Username "${newUsername}" is already taken.` });
                     ws.close(1008, "Username taken"); // Close connection, client should show error and prompt again
                     return;
                }

                // Store the username
                clients.set(ws, newUsername);
                ws.username = newUsername; // Attach to ws object for easy access
                console.log(`Client identified as: ${newUsername}`);

                // Notify the user they are set
                safeSend(ws, { type: 'system', text: `You are connected as ${newUsername}.` });

                // Send current user list ONLY to the newly joined client
                sendUserList(ws);

                // Notify all *other* clients that a new user joined
                broadcast({
                    type: 'system',
                    text: `${newUsername} has joined the chat.`
                }, ws); // Exclude the sender

                // Broadcast updated user list to EVERYONE
                broadcastUserList();
                break;

            case 'message':
                if (!currentUsername) {
                    console.log('Message received from unidentified client');
                    safeSend(ws, { type: 'system', text: 'Error: Cannot send message, not fully connected.' });
                    return;
                }
                const messageText = parsedMessage.text?.trim();
                if (!messageText) {
                    console.log(`Empty message received from ${currentUsername}`);
                    return; // Ignore empty messages
                }
                // Broadcast the message object (server is source of truth)
                broadcast({
                    type: 'message',
                    username: currentUsername,
                    text: messageText // Send trimmed message
                });
                break;

            default:
                console.log('Received unknown message type:', parsedMessage.type);
                safeSend(ws, { type: 'system', text: 'Error: Unknown message type.' });
        }
    });

    ws.on('close', (code, reason) => {
        const username = ws.username;
        const reasonText = reason?.toString() || 'N/A';
        if (username) {
            console.log(`Client ${username} disconnected (Code: ${code}, Reason: ${reasonText})`);
            const existed = clients.delete(ws); // Remove client
            if (existed) {
                 // Notify remaining clients
                broadcast({
                    type: 'system',
                    text: `${username} has left the chat.`
                });
                // Broadcast updated user list
                broadcastUserList();
            }
        } else {
            console.log(`Unidentified client disconnected (Code: ${code}, Reason: ${reasonText})`);
            clients.delete(ws); // Ensure removal if somehow added without username
        }
    });

    ws.on('error', (error) => {
        const username = ws.username;
        console.error(`WebSocket error for client ${username || '(unidentified)'}:`, error);
        // Error often precedes close, but handle removal here just in case
        if (clients.has(ws)) {
             console.log(`Removing client ${username || '(unidentified)'} due to error.`);
             clients.delete(ws);
              if (username) {
                   broadcast({
                       type: 'system',
                       text: `${username} disconnected due to an error.`
                   });
                   broadcastUserList();
              }
        }
        // Ensure the socket is terminated after an error
        ws.terminate();
    });
});

// Helper to safely send data to a client, handling potential errors
function safeSend(ws, dataObj) {
    if (ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(dataObj), (err) => {
                if (err) {
                    console.error(`Failed to send message to ${ws.username || 'client'}:`, err);
                    // Consider closing connection if send fails
                    // ws.terminate();
                }
            });
        } catch (error) {
             console.error(`Error stringifying data for ${ws.username || 'client'}:`, error);
        }
    } else {
         console.log(`Attempted to send to closed socket for ${ws.username || 'client'}`);
    }
}


// Helper function to broadcast a message object to all connected clients
// Optionally exclude a specific client
function broadcast(messageObj, senderWs = null) {
    const messageString = JSON.stringify(messageObj);
    console.log(`Broadcasting (excluding sender: ${!!senderWs}):`, messageString);
    clients.forEach((username, clientWs) => {
         // Send only to identified clients and not the excluded sender
        if (username && clientWs !== senderWs && clientWs.readyState === WebSocket.OPEN) {
            safeSend(clientWs, messageObj); // Use safeSend now
        } else if (!username && clientWs.readyState === WebSocket.OPEN) {
            // console.log('Skipping broadcast to unidentified client');
        } else if (clientWs.readyState !== WebSocket.OPEN) {
             console.log(`Skipping broadcast to non-open client ${username || '(unidentified)'}`);
        }
    });
}


// Helper function to get the list of current usernames
function getUserList() {
    // Filter out any potentially null/undefined usernames, just in case
    return Array.from(clients.values()).filter(username => !!username).sort(); // Sort alphabetically
}

// Helper function to send the user list to a specific client
function sendUserList(targetWs) {
     if (targetWs.readyState === WebSocket.OPEN) {
          const userList = getUserList();
          console.log(`Sending user list to ${targetWs.username}:`, userList);
          safeSend(targetWs, { type: 'userList', users: userList });
     }
}

// Helper function to broadcast the user list to everyone
function broadcastUserList() {
    const userList = getUserList();
     console.log('Broadcasting updated user list:', userList);
     // Broadcast the user list type message (no sender exclusion needed here)
     const messageObj = { type: 'userList', users: userList };
     const messageString = JSON.stringify(messageObj);
     clients.forEach((username, clientWs) => {
          if (username && clientWs.readyState === WebSocket.OPEN) { // Only send to identified, open clients
              safeSend(clientWs, messageObj);
          }
     });
}
