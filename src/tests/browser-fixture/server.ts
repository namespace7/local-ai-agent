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

        <form id="agent-form">
          <label for="name">Name</label>
          <input
            id="name"
            name="name"
            type="text"
            placeholder="Enter your name"
          />

          <button id="submit" type="submit">
            Submit
          </button>
        </form>

        <p id="result">Status: waiting</p>

        <script>
          document
            .getElementById("agent-form")
            .addEventListener("submit", (event) => {
              event.preventDefault();

              const name = document
                .getElementById("name")
                .value
                .trim();

              document.getElementById("result").textContent =
                name
                  ? "Status: submitted for " + name
                  : "Status: name is required";
            });
        </script>
      </body>
    </html>
  `);
});

server.listen(3001, "127.0.0.1", () => {
  console.log("Test page running at http://127.0.0.1:3001");
});
