// Exercise reset archive/export and interrupted worker recovery with the new default store.
process.env.XWX_DECK_TEST_PRIVATE_STORE='1';
await import('./application-reset-test.mjs');
