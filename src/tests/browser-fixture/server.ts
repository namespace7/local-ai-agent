import { createServer } from "node:http";

const server = createServer((_request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/html",
  });

  response.end(`
    <!doctype html>
    <html>
      <head>
        <title>Local AI Agent Test Page</title>
      </head>
      <body>
        <h1>Local AI Agent</h1>
        <p>This is a Playwright test page.</p>
        <p>Status: healthy</p>
      </body>
    </html>
  `);
});

server.listen(3001, "127.0.0.1", () => {
  console.log("Test page running at http://127.0.0.1:3001");
});
