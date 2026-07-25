import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://nyxvhnjxbcblksmdxqtw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_bF587rI3l3oO-UKQrKFyUg_RTbmgOIW";

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
