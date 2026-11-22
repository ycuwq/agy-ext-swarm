## Summary

## Checklist
- [ ] Zero hardcoded vendor endpoints, default proprietary model names, or local user paths
- [ ] All relative TypeScript imports use `.js` suffixes (`NodeNext`)
- [ ] `cd server && pnpm typecheck && pnpm build` succeeded (`dist/board.html < 1 MiB`)
- [ ] `cd server && pnpm test:providers` passed
