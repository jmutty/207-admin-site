  // Keep the UI in sync if the session ends in another tab.
  supabase.auth.onAuthStateChange((event) => {
    if (event === "PASSWORD_RECOVERY") RECOVERY = true; // a "Forgot password" link: ask for a new password after sign-in
    if (event === "SIGNED_OUT") location.reload(); // drop everything that was on screen
  });

  init();
})();
