# My Books: personal ebook reader

A web app for reading EPUB and PDF files you own, on a phone, tablet, or PC browser. Your books, reading progress, highlights, and bookmarks are stored in the browser on each device.

## Features (first version)
- Library shelf with covers and reading progress
- Add EPUB and PDF files from your device
- Reading progress percentage, saved automatically
- EPUB: select text to highlight, add notes, go back to any highlight
- PDF: bookmarks and page position
- Bookmarks and highlights in one list
- Works offline after the first load; can be installed to the home screen

## Not yet included
- Sync between devices (planned: Google Drive)
- DRM-protected books (Apple Books and Kindle purchases cannot be opened)
- PDF highlights (planned)

## Run on your PC
Open `index.html` in Chrome or Edge. For the service worker (offline mode) and installation, use the hosted address below.

## Put it on your phone (GitHub Pages)
1. Push this folder to your GitHub repository.
2. On github.com, open the repository, go to **Settings › Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, then **Save**.
4. After a minute the app is at `https://binitpatel87.github.io/<repository-name>/`.
5. On your phone, open that address:
   - **iPhone (Safari):** Share › **Add to Home Screen**
   - **Android (Chrome):** menu › **Install app** or **Add to Home screen**

Your books stay on the device. Only the app code is on GitHub.

## Privacy
Nothing is uploaded. Book files are stored only in the browser's local storage on each device. Clearing the browser's site data deletes the library, so keep your original files as a backup.
