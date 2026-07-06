// TagTag imports its own sound asset directly (see `sound` in index.ts) and bundles via Vite in
// consuming apps. This package has no tsconfig of its own, so it can't rely on an app's
// `vite/client` types being present — declare the one asset extension it actually uses so it
// type-checks on its own merits, not by accident of whichever app happens to import it.
declare module "*.wav" {
	const src: string
	export default src
}
