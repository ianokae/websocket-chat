require('dotenv').config(); // Load .env file variables
const fs = require('fs'); // Add file system module
const path = require('path'); // Add path module

const WebSocket = require('ws');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// --- AI Memory Configuration ---
const AI_HISTORY_DIR = path.join(__dirname, 'ai');
const AI_MEMORY_LENGTH = 5; // Number of past user/AI message pairs to remember

// Ensure AI history directory exists
if (!fs.existsSync(AI_HISTORY_DIR)) {
    try {
        fs.mkdirSync(AI_HISTORY_DIR);
        console.log(`Created AI history directory: ${AI_HISTORY_DIR}`);
    } catch (error) {
        console.error(`Failed to create AI history directory: ${AI_HISTORY_DIR}`, error);
        // Decide if this is fatal or not. For now, we'll log and continue.
    }
}
// -----------------------------

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

// --- NEW: AI User History Functions ---

function getUserAiHistoryFilePath(username) {
    // Basic sanitization: replace potentially problematic characters.
    // A more robust solution might involve hashing or stricter validation.
    const safeUsername = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(AI_HISTORY_DIR, `${safeUsername}.json`);
}

function loadUserAiHistory(username) {
    const filePath = getUserAiHistoryFilePath(username);
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            const history = JSON.parse(data);
            // Basic validation
            if (Array.isArray(history)) {
                 console.log(`Loaded ${history.length} AI interactions for user ${username}`);
                 return history;
            } else {
                 console.warn(`Invalid AI history format found for user ${username}. Starting fresh.`);
                 return [];
            }
        } else {
            // console.log(`No AI history file found for user ${username}, starting fresh.`);
            return []; // No history yet
        }
    } catch (error) {
        console.error(`Error loading AI history for user ${username}:`, error);
        return []; // Return empty history on error
    }
}

function saveUserAiHistory(username, userPrompt, aiResponse) {
    const filePath = getUserAiHistoryFilePath(username);
    if (!userPrompt || !aiResponse) {
         console.warn(`Attempted to save incomplete AI interaction for ${username}. Aborting.`);
         return; // Don't save incomplete entries
    }

    let history = loadUserAiHistory(username); // Load existing history

    // Add the new interaction
    history.push({ userPrompt, aiResponse });

    // Trim history to the desired length
    if (history.length > AI_MEMORY_LENGTH) {
        history = history.slice(-AI_MEMORY_LENGTH); // Keep only the last N items
    }

    try {
        fs.writeFileSync(filePath, JSON.stringify(history, null, 2), 'utf8'); // Pretty print JSON
        console.log(`Saved AI interaction (${history.length} total) for user ${username}`);
    } catch (error) {
        console.error(`Error writing AI history for user ${username}:`, error);
    }
}
// --- End AI User History Functions ---

const wss = new WebSocket.Server({ port: 8086 });

// Store clients with their associated usernames: { ws => username }
const clients = new Map();

console.log('WebSocket server started on port 8086');

wss.on('connection', (ws) => {
    console.log('Client connected (pending identification)');

    ws.on('message', async (message) => {
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
                     // Use helpers to create and process the action message
                     const userActionMessage = createActionMessage(currentUsername, args);
                     processAndBroadcast(userActionMessage); // Broadcast to everyone
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

                     // Use helper to append history and broadcast (excluding sender)
                     processAndBroadcast(leaveMessage, ws);

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
                 // Use helper to append history and broadcast (excluding sender)
                 processAndBroadcast(joinMessage, ws);

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

                // Normal message broadcast (broadcast user messages immediately)
                const originalMessage = {
                    type: 'message',
                    username: currentUsername,
                    text: messageText
                };
                processAndBroadcast(originalMessage); // Broadcast user message first

                // --- New AI Trigger Logic ---
                if (model) { // Only proceed if AI is configured
                    let aiShouldRespond = false;
                    let aiQuery = '';

                    // 1. Check for explicit triggers: @ai or ai: or ai? at the start
                    const explicitMentionMatch = messageText.match(/^@?ai[:?]?\\s+(.*)/i);
                    if (explicitMentionMatch && explicitMentionMatch[1]) {
                        aiShouldRespond = true;
                        aiQuery = explicitMentionMatch[1].trim();
                        console.log(`Explicit AI mention detected. Query: "${aiQuery}"`);
                    } else {
                        // 2. Check for potential implicit triggers: " ai " or " ai." etc.
                        // \\b matches word boundaries - covers spaces, punctuation, start/end of string
                        const implicitMentionRegex = /\b(ai)\b/i;
                         if (implicitMentionRegex.test(messageText)) {
                            console.log(`Potential implicit AI mention detected in: "${messageText}"`);
                             try {
                                 // Ask AI if it thinks it's being addressed
                                 const determination = await checkIfAiAddressed(messageText);
                                 console.log("AI determination:", determination);
                                 if (determination?.addressed) {
                                     aiShouldRespond = true;
                                     aiQuery = messageText; // Use the original message text for context
                                     console.log(`AI determined it was addressed. Reason: ${determination.reason}. Querying with full text.`);
                                 } else {
                                      console.log(`AI determined it was NOT addressed. Reason: ${determination?.reason || 'N/A'}`);
                                 }
                             } catch (error) {
                                 console.error("Error during AI address check:", error);
                                 // Decide if you want to notify user or just fail silently
                                 // safeSend(ws, { type: 'system', text: 'Error checking AI mention.' });
                             }
                        }
                    }

                    // 3. If AI should respond, get and process the response
                    if (aiShouldRespond && aiQuery) {
                        console.log(`Asking AI (final query): "${aiQuery}"`);

                        // --- Load user's AI history ---
                        const userAiHistory = loadUserAiHistory(currentUsername);
                        // --------------------------------

                        getGeminiResponse(aiQuery, userAiHistory) // Pass history to Gemini
                            .then(aiResponse => {
                                const trimmedResponse = aiResponse?.trim();

                                // --- Save the interaction to history ---
                                if (trimmedResponse) { // Only save if AI provided a non-empty response
                                     saveUserAiHistory(currentUsername, aiQuery, aiResponse); // Save original prompt and response
                                }
                                // ---------------------------------------

                                // (Processing logic for /me or regular message remains the same)
                                if (trimmedResponse && trimmedResponse.toLowerCase().startsWith('/me ')) {
                                    const actionPart = trimmedResponse.substring(4).trim();
                                    if (actionPart) {
                                        const aiActionMessage = createActionMessage('AI', actionPart);
                                        console.log('AI performing action:', aiActionMessage.text);
                                        processAndBroadcast(aiActionMessage);
                                    } else {
                                        console.warn('AI sent an empty /me command.');
                                    }
                                } else if (trimmedResponse) { // Ensure there is a response before sending
                                    const aiMessage = {
                                        type: 'message',
                                        username: 'AI',
                                        text: aiResponse // Use original (untrimmed) response
                                    };
                                    processAndBroadcast(aiMessage);
                                } else {
                                     console.log("AI returned an empty response.");
                                }
                            })
                            .catch(error => {
                                console.error("Error getting AI response:", error);
                                // Find the user's socket to send the error back, if possible
                                // This requires mapping username back to ws, which we don't store directly
                                // For simplicity, maybe just log it or send to the original ws if easily available
                                // safeSend(ws, { type: 'system', text: 'Error: Could not get response from AI.' });
                                console.error(`Could not send AI error message directly to user ${currentUsername} (socket not readily available here).`);
                            });
                    }
                }
                // --- End AI Trigger Logic ---
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
                 if (code !== 1000 || !reason?.toString().startsWith('Quit command used')) {
                     // Create leave message object
                     const leaveMessage = {
                         type: 'system',
                         text: `${username} has left the chat.`
                     };
                     // Use helper to append history and broadcast to everyone
                     processAndBroadcast(leaveMessage);
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
                   // Use helper to append history and broadcast
                   processAndBroadcast(disconnectErrorMessage);
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

// --- New function to check if AI is being addressed ---
async function checkIfAiAddressed(messageText) {
    if (!model) {
        console.log("AI model not initialized. Skipping address check.");
        return { addressed: false, reason: "AI not available" };
    }
    try {
        // Define the desired JSON structure and instruct the model to use it.
        const checkPrompt = `Analyze the following chat message to determine if the user is directly addressing the AI bot named "ai" (e.g., asking it a question, giving it a command, mentioning it directly in a way that requires a response). Consider the context of a casual group chat.

Respond with a JSON object matching this schema:
{
  "addressed": boolean, // true if the AI is being directly addressed or expected to respond, false otherwise
  "reason": string     // A brief explanation for the decision (e.g., "Direct question", "Mentioned incidentally") 
}

Message: "${messageText}"`;

        // Configure the model to output JSON
        const generationConfig = { responseMimeType: "application/json" };

        console.log("Sending determination prompt (JSON mode) to AI:", checkPrompt);
        const result = await model.generateContent({ 
            contents: [{role: "user", parts:[{text: checkPrompt}]}],
            generationConfig 
        });

        const response = await result.response;
        const jsonText = response.text();
        console.log("AI Determination Raw JSON Response:", jsonText);

        // Attempt to parse the JSON response (should be cleaner now)
        try {
            const determination = JSON.parse(jsonText);

            // Basic validation of the parsed object structure
            if (typeof determination === 'object' && determination !== null && typeof determination.addressed === 'boolean' && typeof determination.reason === 'string') {
                 return {
                     addressed: determination.addressed,
                     reason: determination.reason
                 };
            } else {
                 console.error("AI determination response has invalid structure:", determination);
                 return { addressed: false, reason: "Invalid structure in AI JSON response" };
            }
        } catch (parseError) {
            console.error("Error parsing AI determination JSON:", parseError, "Raw JSON text:", jsonText);
            return { addressed: false, reason: "Failed to parse AI JSON response" };
        }
    } catch (error) {
        console.error("Error calling Gemini API for address check:", error);
        return { addressed: false, reason: "API error during check" }; // Indicate failure
    }
}

// --- Updated function to get response from Gemini ---
// Now accepts user-specific AI interaction history
async function getGeminiResponse(prompt, history = []) { // Add history parameter with default
    if (!model) {
        console.log("AI model not initialized. Skipping Gemini request.");
        return "Sorry, the AI is currently unavailable.";
    }
    try {
        // --- Construct history string for the prompt ---
        let historyContext = "";
        if (history && history.length > 0) {
             historyContext = "Here is the recent conversation history with this user (most recent interaction last):\n";
             history.forEach(interaction => {
                 historyContext += `- User: "${interaction.userPrompt}"\n`;
                 historyContext += `- AI: "${interaction.aiResponse}"\n`;
             });
             historyContext += "\nYou may consider this context when responding.\n\n";
        }
        // ---------------------------------------------

        // Updated prompt including history context
        const finalPrompt = `You are an AI assistant in a simple WebSocket chat group application (like IRC) built by and for youth who are inspired by technology, business, and creativity. Keep your single-line responses concise and conversational, ideally 1-4 sentences. Do not use markdown or special formatting. You can also perform actions by starting your *entire response text* with "/me " (e.g., "/me looks thoughtful."). \n\n${historyContext}Respond to the following latest user message:\n"${prompt}"`;

        console.log("Sending final prompt to AI (with history):", finalPrompt); // Log the full prompt
        // Only pass the final prompt string to generateContent
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

// --- NEW: Helper to create consistent action message objects ---
function createActionMessage(username, actionText) {
    const formattedText = `* ${username} ${actionText} *`;
    return {
        type: 'action',
        username: username, // Include username for client-side logic if needed
        text: formattedText
    };
}

// --- NEW: Helper to append to history and broadcast --- 
function processAndBroadcast(messageObject, excludeSenderWs = null) {
    if (!messageObject || typeof messageObject !== 'object' || !messageObject.type) {
        console.warn('Attempted to process invalid message object:', messageObject);
        return;
    }
    appendToHistory(messageObject);
    broadcast(messageObject, excludeSenderWs);
}
