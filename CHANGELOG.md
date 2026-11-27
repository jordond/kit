# Changelog

## 0.13.1 (2026-11-27)

### Fixes

- **release:** `kit release android` (Kotlin toolchain, `release.android.sentry` set) no longer fails with "wrote no R8 mapping" when R8 is up to date. The mapping is now taken from the build output of the AAB that was built, whatever its mtime, instead of only a `mapping.txt` written during this build. A build with no mapping at all still fails.
