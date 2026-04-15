const { Client } = require("ssh2")
const fs = require("fs")
const host = process.env.VPS_SSH_HOST
const port = Number(process.env.VPS_SSH_PORT || "22")
const username = process.env.VPS_SSH_USER || "ubuntu"
const password = process.env.VPS_SSH_PASSWORD

const [localPath, remotePath] = process.argv.slice(2)

if (!localPath || !remotePath) {
  console.error("Usage: node vps-upload.js <localPath> <remotePath>")
  process.exit(1)
}

if (!host || !password) {
  console.error("VPS_SSH_HOST and VPS_SSH_PASSWORD are required")
  process.exit(1)
}

const conn = new Client()

conn
  .on("ready", () => {
    conn.sftp((err, sftp) => {
      if (err) {
        console.error(err)
        conn.end()
        process.exit(1)
        return
      }

      sftp.fastPut(localPath, remotePath, (writeErr) => {
        if (writeErr) {
          console.error(writeErr)
          conn.end()
          process.exit(1)
          return
        }
        sftp.end()
        conn.end()
      })
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
