require('dotenv').config(); // Load .env file variables
const fs = require('fs'); // Add file system module
const path = require('path'); // Add path module

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

const HISTORY_FILE = path.join(__dirname, 'chat_history.json'); // Define history file path
let chatHistory = []; // In-memory cache of history

// Function to load history from file
function loadHistory() {
    try {
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            chatHistory = JSON.parse(data);
            console.log(`Loaded ${chatHistory.length} messages from history.`);
        } else {
            console.log('No history file found, starting fresh.');
            chatHistory = [];
        }
    } catch (error) {
        console.error('Error loading chat history:', error);
        chatHistory = []; // Start with empty history on error
    }
}

// Function to append a message to the history file
function appendToHistory(message) {
     // Basic validation to avoid storing incomplete messages
     if (!message || typeof message !== 'object' || !message.type) {
         console.warn('Attempted to append invalid message to history:', message);
         return;
     }
     chatHistory.push(message);
     try {
         // Asynchronous write is generally better for performance but adds complexity.
         // Synchronous write is simpler for this example.
         fs.writeFileSync(HISTORY_FILE, JSON.stringify(chatHistory, null, 2), 'utf8'); // Pretty print JSON
     } catch (error) {
         console.error('Error writing to chat history:', error);
         // Optional: Implement retry logic or handle error more robustly
     }
}

// Load history on server start
loadHistory();

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

        // --- Handle Command Type --- New section
        if (parsedMessage.type === 'command') {
            if (!currentUsername) {
                 console.log('Command received from unidentified client');
                 safeSend(ws, { type: 'privateSystem', text: 'Error: Cannot process command, not fully connected.' });
                 return;
             }

             const command = parsedMessage.command?.toLowerCase();
             const args = parsedMessage.args?.trim() || ''; // Ensure args is a string

             console.log(`Received command '/${command}' from ${currentUsername} with args: "${args}"`);

             switch (command) {
                 case 'me':
                     if (!args) {
                         safeSend(ws, { type: 'privateSystem', text: 'Usage: /me <action>' });
                         return;
                     }
                     const actionText = `* ${currentUsername} ${args} *`;
                     const actionMessage = {
                         type: 'action', // Use a dedicated type for /me actions
                         username: currentUsername, // Add username for client-side alignment
                         text: actionText
                     };
                     broadcast(actionMessage);
                     appendToHistory(actionMessage); // Append action to history
                     break;
                 case 'quit':
                     // Use the whole argument string as the reason, if provided
                     const reason = args.trim() || null; // Get trimmed args or null if empty

                     const leaveText = reason
                         ? `${currentUsername} has left the chat (${reason})` // Keep parens for display consistency
                         : `${currentUsername} has left the chat.`;

                     const leaveMessage = {
                         type: 'system',
                         text: leaveText
                     };

                     console.log(`${currentUsername} is quitting.${reason ? ' Reason: ' + reason : ''}`);

                     // Log the message being broadcast
                     console.log('Broadcasting leave message:', JSON.stringify(leaveMessage));

                     // Append leave message to history
                     appendToHistory(leaveMessage);
                     // Notify remaining clients (exclude sender)
                     broadcast(leaveMessage, ws);
                     // Broadcast updated user list
                     broadcastUserList();
                     // Close the connection gracefully with a reason
                     ws.close(1000, `Quit command used${reason ? ': ' + reason : ''}`);
                     break;
                 // Add more command cases here in the future
                 default:
                     safeSend(ws, { type: 'privateSystem', text: `Unknown command '/${command}'` });
             }
             return; // Command processed, no further action needed
         }
         // --- End Handle Command Type ---

        switch (parsedMessage.type) {
            case 'setUsername':
                const newUsername = parsedMessage.username?.trim();
                if (!newUsername) {
                    console.log('Invalid username received');
                    safeSend(ws, { type: 'system', text: 'Error: Invalid username provided.' });
                    ws.close(1008, "Invalid username"); // Close connection
                    return;
                }

                // --- Add check for reserved AI name ---
                if (newUsername.toLowerCase() === 'ai') {
                    console.log('Attempt to register as reserved username "AI".');
                    safeSend(ws, { type: 'system', text: 'Error: Username "AI" is reserved.' });
                    ws.close(1008, "Reserved username"); // Close connection
                    return;
                }
                // --------------------------------------

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

                // Send chat history ONLY to the newly joined client
                sendChatHistory(ws);

                // Notify the user they are set (after history is sent)
                safeSend(ws, { type: 'system', text: `You are connected as ${newUsername}. Chat history loaded.` });

                // Send current user list ONLY to the newly joined client (can stay here or move after history)
                sendUserList(ws);

                // Create join message object
                 const joinMessage = {
                     type: 'system',
                     text: `${newUsername} has joined the chat.`
                 };
                // Append join message to history
                appendToHistory(joinMessage);
                // Notify all *other* clients that a new user joined
                broadcast(joinMessage, ws); // Exclude the sender

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
                appendToHistory(originalMessage); // Append user message to history

                // Check if message is for AI
                if (messageText.toLowerCase().startsWith('ai ') && model) {
                    const question = messageText.substring(3).trim(); // Get text after "AI "
                    if (question) {
                        console.log(`Asking AI: "${question}"`);
                        // Get AI response asynchronously
                        getGeminiResponse(question)
                            .then(aiResponse => {
                                // Create the AI message object
                                const aiMessage = {
                                    type: 'message',
                                    username: 'AI',
                                    text: aiResponse
                                };
                                // Append to history FIRST
                                appendToHistory(aiMessage);
                                // THEN broadcast it
                                broadcast(aiMessage);
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
                 // Only broadcast the leave message from here if it wasn't a normal /quit command exit
                 if (code !== 1000 || !reason?.toString().startsWith('Quit command used')) {
                     // Create leave message object
                     const leaveMessage = {
                         type: 'system',
                         text: `${username} has left the chat.`
                     };
                     // Append leave message to history (might consider skipping if already added by /quit?)
                     // For simplicity, we might double-append here, but broadcast is the key part to fix.
                     appendToHistory(leaveMessage);
                     // Notify remaining clients
                     broadcast(leaveMessage);
                 }
                 // Always broadcast updated user list regardless of close reason
                 broadcastUserList();
            }
        } else {
            console.log(`Unidentified client disconnected (Code: ${code}, Reason: ${reasonText})`);
            clients.delete(ws); // Ensure removal if somehow added without username
        }
        // Ensure the socket is terminated after an error
        ws.terminate();
    });

    ws.on('error', (error) => {
        const username = ws.username;
        console.error(`WebSocket error for client ${username || '(unidentified)'}:`, error);
        // Error often precedes close, but handle removal here just in case
        if (clients.has(ws)) {
             console.log(`Removing client ${username || '(unidentified)'} due to error.`);
             clients.delete(ws);
              if (username) {
                   // Create disconnect error message object
                   const disconnectErrorMessage = {
                       type: 'system',
                       text: `${username} disconnected due to an error.`
                   };
                   // Append disconnect error message to history
                   appendToHistory(disconnectErrorMessage);
                   // Notify remaining clients
                   broadcast(disconnectErrorMessage);
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
        // Add instructions to the prompt for chat-like responses
        const finalPrompt = `You are an AI assistant in a simple WebSocket chat group application (like IRC) built by and for youth who are inspired by technology and creativity. Keep your responses concise and conversational, ideally 2-3 sentences maximum. Do not use markdown or special formatting. The user's message is: ${prompt}`;
        console.log("Sending final prompt to AI:", finalPrompt); // Log the full prompt
        const result = await model.generateContent(finalPrompt);
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

// Helper function to send the full chat history to a specific client
function sendChatHistory(targetWs) {
    if (targetWs.readyState === WebSocket.OPEN) {
         console.log(`Sending chat history (${chatHistory.length} messages) to ${targetWs.username}`);
         safeSend(targetWs, { type: 'chatHistory', history: chatHistory });
    }
}
