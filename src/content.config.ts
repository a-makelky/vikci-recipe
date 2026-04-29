import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

import { recipeFrontmatterSchema } from "./lib/recipe-schema";

const recipes = defineCollection({
  loader: glob({
    pattern: "**/*.md",
    base: "./src/content/recipes"
  }),
  schema: recipeFrontmatterSchema
});

export const collections = { recipes };
