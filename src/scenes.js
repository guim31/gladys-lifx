// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// On, brightness, colour and white are already Gladys scene actions on the
// light features. These two run what only LIFX knows: a pulse in a colour
// (an alert that ends by itself, the light back as it was), and the firmware
// effects of the strips and matrices with their speed, direction and palette.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async pulse(hub, { fields }) {
    const { durationMs } = await hub.pulse(fields.device, {
      color: fields.color,
      mode: fields.mode,
      period: fields.period,
      cycles: fields.cycles,
    });
    return { duration_seconds: Math.round(durationMs / 100) / 10 };
  },

  async start_effect(hub, { fields }) {
    const { effect } = await hub.startEffect(fields.device, {
      effect: fields.effect,
      speed: fields.speed,
      direction: fields.direction,
      palette: fields.palette,
    });
    return { effect };
  },
};
