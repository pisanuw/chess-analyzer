// Derive drills on the hosted store from local game data. Run by publish-web.sh
// with SUPABASE_URL and SUPABASE_SERVICE_KEY set: games are read from the local
// DATA_DIR while drill reads/writes go to Supabase. Each member gets their own
// row (key drills:<id>), built from the games they can see (own + shared scout),
// so the mirror serves per-member drills with each member's reviews preserved.
const { syncAllDrills } = await import('../server/drills.js');
const { listMembers } = await import('../server/users.js');
for (const m of await listMembers()) {
  await syncAllDrills(m.id);
  console.log(`hosted drill store synced for ${m.id}`);
}
