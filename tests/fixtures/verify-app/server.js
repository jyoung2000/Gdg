// A deliberately tiny web app for the docker+browser verification loop:
// one page, one button, observable state change.
const http = require('node:http');

let clicks = 0;

const page = () => `<!doctype html>
<html><head><title>Verify App</title></head>
<body>
  <h1>Meridian Verify App</h1>
  <p>Clicks: <span id="count">${clicks}</span></p>
  <button id="bump" onclick="fetch('/bump',{method:'POST'}).then(r=>r.json()).then(d=>{document.getElementById('count').textContent=d.clicks})">Bump</button>
</body></html>`;

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/bump') {
      clicks += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ clicks }));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200);
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page());
  })
  .listen(3000, () => console.log('verify-app on 3000'));
