# YouTube Live Chat Overlay

YouTube live chat overlay for use in OBS Studio. Displays messages with avatar, name colored by role, and text just like YouTube's chat, but styled for streaming.

**Colors:**
- 🔴 **Red** - regular viewers
- 🔵 **Blue** - moderators
- 🟢 **Green** - channel members

## What I couldn't get working:
- Messages that were removed by automod and then came back

---

## Requirements

- [Node.js](https://nodejs.org) (version 18 or higher - download the LTS version)
- OBS Studio (any recent version)

---

## Installation

**1. Download or clone the project**

If you have Git installed:
```
git clone https://github.com/emilia-gomes2008/chat.git
```

Or download the ZIP from GitHub and extract the folder.

**2. Install dependencies**

Open a terminal inside the project folder and run:
```
npm install
```

This installs everything automatically. You only need to do this once.

---

## How to use

**1. Start the server**

In the terminal, inside the project folder:
```
npm start
```

You'll see the message:
```
YouTube Live Chat overlay: http://localhost:3000
```

Leave the terminal open while you're streaming.

**2. Configure the overlay**

Open your browser at `http://localhost:3000`.

You'll see the setup screen:

- Choose the ID type:
  - **Channel ID** - your channel's ID (starts with `UC`, e.g. `UCxxxxxxxxxxxxxxxx`). The system finds the live stream automatically.
  - **Video / Live ID** - the ID of a specific video (appears in the live stream's URL, e.g. `dQw4w9WgXcQ`).
- Paste the ID into the field and click **Generate URL for OBS**.
- Copy the generated URL.

**How to find your Channel ID:**
1. Go to your channel on YouTube
2. Click **Customize channel** → **Basic info**
3. Scroll down to "Channel ID" - starts with `UC`

**3. Add it to OBS**

1. In OBS, click **+** in the Sources list
2. Choose **Browser Source**
3. Paste the copied URL into the **URL** field
4. Set the size: **Width 1920 × Height 1080** (or your scene's size)
5. **Important:** uncheck the *"Refresh browser when scene becomes active"* option - this prevents the chat from restarting when switching scenes
6. Click OK

---

## Why doesn't the chat stop when switching scenes?

Most chat overlays stop because they run entirely in the browser. When OBS deactivates the source on a scene switch, the browser loses its connection to YouTube and has to reconnect from scratch.

In this project:

- The **connection to YouTube lives on the Node.js server**, which runs separately from OBS
- OBS only displays the interface - if the browser drops, it **reconnects automatically** to the local server
- The server has **automatic reconnection** to YouTube: if the live stream drops or the internet fails, it retries at increasing intervals (5 s, 10 s, 20 s… up to 60 s)

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "npm is not recognized" | Install Node.js from [nodejs.org](https://nodejs.org) and restart the terminal |
| Chat doesn't show up | Check that the channel is currently live |
| Avatars don't load | Normal on some channels - the name and message still appear |
| Chat stopped updating | The server reconnects on its own. Check the terminal to follow the status |
| Port 3000 in use | Close other programs using port 3000, or change the port number at the end of `server/server.js` |

---

## Customization

### Maximum number of visible messages

In [public/js/chat.js](public/js/chat.js), line 4:
```js
const MAX_MESSAGES = 30; // change to whatever number you want
```

### Name colors

In [public/css/style.css](public/css/style.css):
```css
.message.chatter .name { background: #dd2222; } /* red */
.message.mod     .name { background: #1a5fff; } /* blue */
.message.member  .name { background: #1a9e45; } /* green */
```

### Font size

In [public/css/style.css](public/css/style.css), search for `.name` and `.text` and change the `font-size` value.

---

## Project structure

```
├── index.html             # Standalone copy of the setup screen + overlay
├── package.json           # Project dependencies
├── server/
│   ├── server.js          # Node.js server (connects to YouTube and broadcasts the chat)
│   └── live-chat.js       # YouTube live chat connection logic
└── public/
    ├── index.html         # Setup screen + overlay (served by the app)
    ├── css/
    │   └── style.css      # Chat visual style
    └── js/
        └── chat.js        # Client logic (WebSocket + rendering)
```
