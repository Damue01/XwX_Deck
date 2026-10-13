// Same actual multi-account/usage/routing/logout flows using the production file mode.
process.env.XWX_DECK_TEST_PRIVATE_STORE='1';
await import('./official-accounts-test.mjs');
