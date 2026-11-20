# Salon Turn

Nail salon turn tracker. Vite + Tailwind (built, not CDN) + Firebase Firestore + installable PWA.

## Run on your computer
    npm install
    npm run dev        # open the address it prints (http://localhost:5173/salon-turn/)

## Publish
Push to the `main` branch. GitHub Actions (`.github/workflows/deploy.yml`) builds and publishes to GitHub Pages.
First time only: GitHub repo -> Settings -> Pages -> Source = "GitHub Actions".

## Notes
- If the repo is not named `salon-turn`, change `base` in `vite.config.js`.
- Services are saved with a Firestore transaction; techs/logs are saved as separate fields.
