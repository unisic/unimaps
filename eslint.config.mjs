import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// .svelte files are type- and a11y-checked by svelte-check (npm run typecheck)
const eslintConfig = defineConfig([
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  globalIgnores([".next/**", "out/**", "dist/**", "node_modules/**", "output/**"]),
]);

export default eslintConfig;
