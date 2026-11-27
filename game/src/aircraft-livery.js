/**
 * Panel lines, exhaust staining and belly grime for the airframe's paint.
 *
 * The hull is a lathe with a single flat colour, and a flat colour at 0.34 roughness reads as
 * moulded plastic however good the silhouette is — the eye gets no scale cue from it, because
 * every real aeroplane is a patchwork of removable panels, each with a seam, and each seam has
 * dirt in it.
 *
 * This is shading, not a texture: the fragment stage keys off the model's own object space, so
 * there is no UV layout to get wrong, no image to load, and no resolution to run out of when the
 * camera gets close. Three terms:
 *
 *  - **Panel seams.** Thin dark rings at fixed stations down the fuselage, plus a few longitudinal
 *    seams around the barrel. Both are one-pixel-ish in screen space because they are `smoothstep`
 *    edges on a distance, not painted lines.
 *  - **Exhaust stain.** Soot carried back from the cowl's exhaust stacks, fading with distance and
 *    biased to the underside, which is where an engine's exhaust actually goes.
 *  - **Belly grime.** Oil, water and grass stains creeping up from the bottom of the fuselage.
 *
 * The fuselage's local frame is Z along the spine (nose at +5.6, tail at −5.0) with the barrel
 * radius around 1 m, so all the stations below are in those metres.
 */
export function enhanceHullMaterial(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vHullLocal;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vHullLocal = position;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vHullLocal;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          // --- Panel seams. Stations down the fuselage. The spacing is deliberately uneven: real
          // panels are sized by what has to come off, not by a ruler, and an even pitch reads as a
          // barber's pole rather than as structure.
          float z = vHullLocal.z;
          float seam = 0.0;
          const int PANELS = 9;
          for (int i = 0; i < PANELS; i++) {
            float station = 4.45 - float(i) * 1.06;      // nose to tail
            // Each seam wanders slightly, so it is not a perfect circle on a tapering barrel.
            float wobble = sin(z * 2.2 + float(i) * 1.7) * 0.035;
            float d = abs(z - station - wobble);
            seam = max(seam, 1.0 - smoothstep(0.0, 0.022, d));
          }
          // Longitudinal seams: four of them around the barrel, at the angles a panel break falls.
          float ang = atan(vHullLocal.y, vHullLocal.x);
          for (int k = 0; k < 4; k++) {
            float target = -2.1 + float(k) * 1.42;
            float da = abs(mod(ang - target + 3.14159, 6.28318) - 3.14159);
            seam = max(seam, 1.0 - smoothstep(0.0, 0.030, da));
          }
          // Rivet rows either side of each seam: a dotted line, which is what sells the scale.
          float rivetRow = 1.0 - smoothstep(0.0, 0.05, abs(fract(z * 9.0) - 0.5) - 0.44);
          seam = max(seam, rivetRow * 0.10 * (1.0 - smoothstep(0.020, 0.055, abs(fract(z * 0.94) - 0.5) * 0.0 + 0.0)));

          // Seams hold dirt, so they are darker and slightly less glossy than the paint.
          diffuseColor.rgb *= 1.0 - seam * 0.42;

          // --- Exhaust stain: from the stacks behind the cowl, carried aft and down.
          float behind = smoothstep(3.55, 2.95, z);            // 0 ahead of the stacks, 1 behind
          float reach = smoothstep(-1.6, 2.4, z);              // fades out toward the tail
          float lowSide = smoothstep(0.35, -0.85, vHullLocal.y); // biased to the belly
          float soot = behind * reach * (0.42 + lowSide * 0.58);
          // Streaky rather than a clean gradient: two frequencies of banding along the barrel.
          soot *= 0.62 + 0.38 * sin(ang * 7.0 + z * 1.1) * sin(z * 3.7 + ang * 2.3);
          diffuseColor.rgb *= 1.0 - clamp(soot, 0.0, 1.0) * 0.30;

          // --- Belly grime: oil and grass creeping up from the lowest panel only.
          float belly = smoothstep(-0.15, -0.95, vHullLocal.y);
          diffuseColor.rgb *= 1.0 - belly * 0.13;

          // A faint warm shift in the grime so it reads as oil rather than as a shadow.
          diffuseColor.rgb = mix(
            diffuseColor.rgb,
            diffuseColor.rgb * vec3(1.04, 0.98, 0.88),
            clamp(belly * 0.5 + soot * 0.35, 0.0, 1.0) * 0.5
          );
        }`,
      );
  };
  // The shader is assembled from onBeforeCompile, so the material has to recompile once it is set.
  material.needsUpdate = true;
}
