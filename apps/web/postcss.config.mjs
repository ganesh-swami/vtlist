import { createRequire } from 'module';

var require = createRequire(import.meta.url);
var module = { exports: {} };

export { default } from "@workspace/ui/postcss.config";