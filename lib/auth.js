// Verifies a Supabase access_token and returns the user, or null. Was an
// identical inline fetch in both paystack-initialize.js and
// paystack-verify.js.
export async function authenticateUser(access_token) {
  const userResp = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: `Bearer ${access_token}` },
  });
  if (!userResp.ok) return null;
  return await userResp.json();
}
