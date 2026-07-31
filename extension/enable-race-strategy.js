(() => {
  'use strict';

  const Speed = globalThis.FribergSpeedStrategy;
  if (!Speed?.installRaceMode) return;
  Speed.installRaceMode({ priorVersion: 'uniform-646-v1' });
})();
