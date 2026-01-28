TrustCheck Live STT (WebSocket Transcribe) - quick demo

1) IAM policy: allow transcribe:StartStreamTranscriptionWebSocket (and optionally StartStreamTranscription).

2) PowerShell:
   cd C:\trustcheck-streaming-ws-min
   $env:AWS_ACCESS_KEY_ID="..."
   $env:AWS_SECRET_ACCESS_KEY="..."
   $env:AWS_REGION="us-east-1"
   npm install
   npm start

3) Open live.html in Chrome, click Start, speak.
