// =============================================================
// THE YARD LAB · ELEVENTY BUILD CONFIG
// =============================================================
import fs from "node:fs";
import path from "node:path";

function loadJsonFolder(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs.readdirSync(folder)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const content = JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'));
      content._slug = f.replace('.json', '');
      return content;
    })
    .sort((a, b) => (a.order || 99) - (b.order || 99));
}

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy({ "src/styles.css": "styles.css" });
  eleventyConfig.addPassthroughCopy({ "src/play/index.html": "play/index.html" });
  eleventyConfig.addPassthroughCopy({ "src/francis-keene/index.html": "francis-keene/index.html" });

  eleventyConfig.addGlobalData("catalog", () => loadJsonFolder("src/_data/catalog"));
  eleventyConfig.addGlobalData("news", () => loadJsonFolder("src/_data/news"));
  eleventyConfig.addGlobalData("articles", () => loadJsonFolder("src/_data/articles"));
  eleventyConfig.addGlobalData("team", () => loadJsonFolder("src/_data/team"));

  eleventyConfig.addFilter("monthYear", (date) => {
    const d = new Date(date);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[d.getMonth()] + " · " + d.getFullYear();
  });

  eleventyConfig.addFilter("monthYearLong", (date) => {
    const d = new Date(date);
    const months = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"];
    return months[d.getMonth()] + " " + d.getFullYear();
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
}
