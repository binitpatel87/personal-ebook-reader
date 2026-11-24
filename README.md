# My Books: personal ebook reader

A web app for reading EPUB and PDF files you own, on a phone, tablet, or PC browser. Books are stored in your own Google Drive, so you can read from any device.

## Features
- Library shelf with covers and reading progress
- Books stored in your Google Drive folder **My Books** (add them from the app, or drop files into the folder from any device)
- Reading progress, highlights, notes, and bookmarks sync between devices through your Drive
- EPUB: select text to highlight, add notes, jump back to any highlight
- PDF: page position and bookmarks
- Books you have opened are kept on the device for offline reading
- Installs to the home screen on iPhone, Android, and PC
- Works on this device only (no Google) until cloud sync is set up

## Sharing the library with friends and family
The library is the **My Books** folder in the owner's Google Drive. Everything in it can be read by the people the owner adds.
- **Owner:** sign in, tap **Sharing**, tap **Unlock sharing tools** (Google asks once for permission to share files), then type a friend's Google email and tap **Give read access**. **Remove** takes access away at once. The page warns if the folder is shared with "anyone with the link" and can switch that off.
- **Friends:** open the app link, sign in with the Google account that was added, and the owner's books appear marked **Shared library**. They can read, highlight and annotate. Their progress, highlights and notes stay private to them. They cannot change or delete the owner's books, and they can still add books of their own.
- **No passwords** are shared. Access is controlled by Google Drive sharing.
- **Google Cloud test users:** while the app is in Google's testing mode, also add each friend's email under Google Cloud Console › Google Auth Platform › Audience › Test users (up to 100 people).
- Only share books you have the right to share.

## Not yet included
- PDF highlights
- DRM-protected books (Apple Books and Kindle purchases cannot be opened)

## Setting up cloud sync (once)
1. In Google Cloud Console, create a project and enable the **Google Drive API**.
2. Set up the **OAuth consent screen** (External, Testing) and add your own Google account as a test user.
3. Create an **OAuth client ID** of type **Web application** with these authorized JavaScript origins:
   - `https://binitpatel87.github.io`
   - `http://localhost:8765` (optional, for testing on a PC)
4. Copy the client ID into `config.js` (`GOOGLE_CLIENT_ID`) and push the change.

The client ID is not a secret. Your books and notes are never stored on GitHub.

## What the app can access in your Google account
- `drive.readonly`: lists and reads the books in your **My Books** folder
- `drive.file`: creates the folder and uploads books you add from the app
- `drive.appdata`: a hidden area for your reading progress, highlights, and bookmarks

## Put it on your phone (GitHub Pages)
The app is hosted at `https://binitpatel87.github.io/personal-ebook-reader/`.
- **iPhone (Safari):** Share › **Add to Home Screen**
- **Android (Chrome):** menu › **Install app** or **Add to home screen**

## Privacy
Book files are stored in your Google Drive and in your browser's local storage on each device. Signing out leaves already-opened books on the device. Clearing the browser's site data removes the local copies, but not the books in Drive.
