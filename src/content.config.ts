import { defineCollection } from "astro:content";

import { recipeFrontmatterSchema } from "./lib/recipe-schema";

const recipes = defineCollection({
  type: "content",
  schema: recipeFrontmatterSchema
});

export const collections = { recipes };
