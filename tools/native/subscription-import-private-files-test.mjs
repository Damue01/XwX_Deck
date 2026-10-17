// Imported official accounts stay source references; their source login is untouched.
process.env.XWX_DECK_TEST_PRIVATE_STORE='1';
await import('./subscription-import-test.mjs');
