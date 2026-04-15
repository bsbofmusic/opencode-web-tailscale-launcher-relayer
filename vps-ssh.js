const { Client } = require("ssh2")

const command = process.argv.slice(2).join(" ")
const host = process.env.VPS_SSH_HOST
const port = Number(process.env.VPS_SSH_PORT || "22")
const username = process.env.VPS_SSH_USER || "ubuntu"
const password = process.env.VPS_SSH_PASSWORD

if (!command) {
  console.error("Remote command is required")
  process.exit(1)
}

if (!host || !password) {
  console.error("VPS_SSH_HOST and VPS_SSH_PASSWORD are required")
  process.exit(1)
}

const conn = new Client()

conn
  .on("ready", () => {
    conn.exec(command, (err, stream) => {
      if (err) {
        console.error(err)
        conn.end()
        process.exit(1)
        return
      }

      stream.on("close", (code) => {
        conn.end()
        process.exit(code ?? 0)
      })

      stream.on("data", (chunk) => process.stdout.write(chunk))
      stream.stderr.on("data", (chunk) => process.stderr.write(chunk))
    })
  })
  .on("error", (err) => {
    console.error(err)
    process.exit(1)
  })
  .connect({
    host,
    port,
    username,
    password,
  })
