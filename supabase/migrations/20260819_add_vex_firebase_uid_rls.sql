-- Firebase project: gen-lang-client-0872570503
-- These policies allow only Firebase-issued tokens from this project to access
-- rows whose user_id matches the token subject. The Flask bridge still verifies
-- Firebase tokens server-side when the service-role path is used.

create policy vex_pages_firebase_uid
  on public.vex_pages
  for all to anon, authenticated
  using (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  )
  with check (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  );

create policy vex_boards_firebase_uid
  on public.vex_boards
  for all to anon, authenticated
  using (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  )
  with check (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  );

create policy vex_board_items_firebase_uid
  on public.vex_board_items
  for all to anon, authenticated
  using (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  )
  with check (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  );

create policy vex_settings_firebase_uid
  on public.vex_settings
  for all to anon, authenticated
  using (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  )
  with check (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  );

create policy vex_typing_stats_firebase_uid
  on public.vex_typing_stats
  for all to anon, authenticated
  using (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  )
  with check (
    auth.jwt() ->> 'iss' = 'https://securetoken.google.com/gen-lang-client-0872570503'
    and auth.jwt() ->> 'aud' = 'gen-lang-client-0872570503'
    and user_id = auth.jwt() ->> 'sub'
  );
