# Odisha Investments Dashboard (Stateless)

Public dashboard with **no storage** and **no cron**. Fetches live data on click, extracts structured records with OpenAI, and visualizes by state.

## Deploy to Vercel (GitHub or ZIP)
- Import repo into Vercel OR upload the ZIP build
- Add Env Var: `OPENAI_API_KEY`
- Deploy

## Debug mode
- Discovery only (no OpenAI): `/api/investments?states=Odisha&window=7d&raw=1`
- Inspect env + discovered count: `/api/investments?states=Odisha&window=7d&debug=1`

## Run locally
```bash
npm install
cp .env.example .env.local   # add your OpenAI key
npm run dev
# open http://localhost:3000
```
