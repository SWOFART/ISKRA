import { expect, test } from '@playwright/test';

test('client design defaults are applied to the rendered shell and map preview', async ({ page }) => {
  await page.goto('/');

  const design = await page.evaluate(() => {
    const rootStyle = getComputedStyle(document.documentElement);
    const shell = document.querySelector('.app-shell');
    const map = document.querySelector('.map-canvas');

    return {
      canvas: rootStyle.getPropertyValue('--client-color-canvas').trim(),
      border: rootStyle.getPropertyValue('--client-color-border').trim(),
      yellowMarker: rootStyle.getPropertyValue('--client-route-yellow-marker').trim(),
      shellBackground: shell ? getComputedStyle(shell).backgroundColor : null,
      mapBackground: map ? getComputedStyle(map).backgroundColor : null,
      mapLatitude: map?.getAttribute('data-latitude'),
      mapLongitude: map?.getAttribute('data-longitude'),
      mapZoom: map?.getAttribute('data-zoom'),
    };
  });

  expect(design).toEqual({
    canvas: '#F5F7F2',
    border: '#78857C',
    yellowMarker: '#8F6400',
    shellBackground: 'rgb(255, 255, 255)',
    mapBackground: 'rgb(234, 241, 235)',
    mapLatitude: '49.14',
    mapLongitude: '9.22',
    mapZoom: '13',
  });
});
