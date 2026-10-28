# Attendly

Attendly is a small Node.js web application backed by SQLite. Run it from the project directory with Node.js 22.13 or later:

```sh
npm start
```

Open <http://localhost:3000>. The first run creates `data/attendly.sqlite`; back up this file to preserve account and attendance data. Keep the database directory on persistent storage when deploying.

## First administrator

Set these environment variables before the first start to create the initial administrator:

- `ADMIN_EMAIL`
- `ADMIN_NAME`
- `ADMIN_PASSWORD` (at least 12 characters)

The first administrator is created only when the database has no administrator. Do not commit credentials. Student accounts can be self-registered. Coordinators and additional administrators must be created by an administrator through `POST /api/admin/users` with a signed-in administrator session and a JSON body containing `name`, `email`, `role` (`coordinator` or `administrator`), and a password of at least 12 characters.

Students added from the roster are pre-registered and can activate their account by creating an account with the same email. They choose their own password during activation.

## Roles and permissions

| Role | Permissions |
| --- | --- |
| Student | View own attendance, check in once per day, activate own pre-registered account |
| Coordinator | Student permissions, view school attendance, view and add students to the roster |
| Administrator | Coordinator permissions, create coordinator and administrator accounts |

Passwords are stored as salted scrypt hashes. Session tokens are random, stored hashed in SQLite, and sent in HttpOnly, SameSite cookies. All database reads and writes happen on the server; the browser no longer stores account, roster, or attendance records in local storage.

For production, serve the application over HTTPS and configure `NODE_ENV=production` so session cookies use the Secure attribute. Run only on a supported Node.js version with `node:sqlite`.
