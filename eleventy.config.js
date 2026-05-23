// =============================================================
// THE YARD LAB · ELEVENTY BUILD CONFIG
// =============================================================

export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy({ "src/styles.css": "styles.css" });
  eleventyConfig.addPassthroughCopy({ "src/play/index.html": "play/index.html" });
  eleventyConfig.addPassthroughCopy({ "src/francis-keene/index.html": "francis-keene/index.html" });

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
