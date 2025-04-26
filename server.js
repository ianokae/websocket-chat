require('dotenv').config(); // Load .env file variables

const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- Add your API Key ---
// Ensure you have your Google AI API key set as an environment variable (GOOGLE_API_KEY)
// or replace "YOUR_API_KEY" below.
// WARNING: Never commit your API key directly into your code!
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || "YOUR_API_KEY";
let genAI;
let model;
if (GOOGLE_API_KEY && GOOGLE_API_KEY !== "YOUR_API_KEY") {
    genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"}); // Or your preferred model
    console.log("Google Generative AI initialized.");
} else {
    console.warn("Google API Key not found or is placeholder. AI functionality will be disabled.");
}
// --------------------------

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

                // Normal message broadcast
                const originalMessage = {
                    type: 'message',
                    username: currentUsername,
                    text: messageText
                };
                broadcast(originalMessage);

                // Check if message is for AI
                if (messageText.toLowerCase().startsWith('ai ') && model) {
                    const question = messageText.substring(3).trim(); // Get text after "AI "
                    if (question) {
                        console.log(`Asking AI: "${question}"`);
                        // Get AI response asynchronously
                        getGeminiResponse(question)
                            .then(aiResponse => {
                                broadcast({
                                    type: 'message',
                                    username: 'AI',
                                    text: aiResponse
                                });
                            })
                            .catch(error => {
                                console.error("Error getting AI response:", error);
                                // Optionally notify the user about the error
                                safeSend(ws, { type: 'system', text: 'Error: Could not get response from AI.' });
                            });
                    }
                }
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
    const userList = Array.from(clients.values()).filter(username => !!username);
    userList.push("AI"); // Always include AI
    return userList.sort((a, b) => { // Custom sort: AI first, then alphabetical
        if (a === "AI") return -1;
        if (b === "AI") return 1;
        return a.localeCompare(b);
    });
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

// --- New function to get response from Gemini ---
async function getGeminiResponse(prompt) {
    if (!model) {
        console.log("AI model not initialized. Skipping Gemini request.");
        return "Sorry, the AI is currently unavailable.";
    }
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        console.log("AI Response:", text);
        return text;
    } catch (error) {
        console.error("Error calling Gemini API:", error);
        return "Sorry, I encountered an error trying to respond."; // User-friendly error
    }
}
// -----------------------------------------------
