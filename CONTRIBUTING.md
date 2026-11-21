# Contributing

Thanks for helping! Students from any university are welcome here.

## Good first contributions
- **Add your university** to the *Universities using it* table in the README (name, city, live link).
- **Translations**: the app text is English; a Bangla (or any language) option would help many riders.
- **Fixes and ideas** from running it on your campus: open an issue first if the change is big.

## Run it locally
```sh
npm install
npm run seed       # local database with a demo route, bus and admin (admin / admin1234)
npm run dev        # http://localhost:3000  (admin: /admin/)
npm run simulate   # another terminal: fake bus GPS so you can see buses move
```
Useful checks: `node scripts/simulate-crowd.js` (riders sharing; verification rules) and
`PUSH_TEST=1 npm run dev` + `node scripts/test-push.js` (push notifications).

## Style
- Plain JavaScript (ES modules on the server, small IIFE modules in the browser), no framework, no build step.
- Keep it free to run: every request counts on the free plans (see *Free-tier budget* in the README).
- Keep the UI simple: clear text, one main action per screen, works on a cheap Android phone.

## Pull requests
Describe what changed and how you tested it (screenshots for UI changes help a lot).
By contributing you agree that your contribution is licensed under the MIT license of this project.
