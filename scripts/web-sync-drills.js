// Derive drills on the hosted store from local game data. Run by publish-web.sh
// with SUPABASE_URL and SUPABASE_SERVICE_KEY set: games are read from the local
// DATA_DIR while drill reads/writes go to Supabase, preserving Kai's reviews.
const { syncAllDrills } = await import('../server/drills.js');
await syncAllDrills();
console.log('hosted drill store synced');
