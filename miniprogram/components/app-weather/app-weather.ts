import { z } from 'zod';
import { getWeather, searchWeatherLocations } from '../../api/client';
import type { WeatherLocation } from '../../api/client';
import type { weatherLocationSchema, weatherSchema } from '../../api/contracts';
import { ApiError, RequestScope, errorMessage } from '../../utils/request';

const requests = new WeakMap<object, {
  scope: RequestScope; generation: number; cityGeneration: number;
  query: WeatherLocation | null; fetchedAt: number;
}>();

function weatherIcon(weather: string) {
  if (weather.includes('雷')) return 'weather-thunder';
  if (/雪|冰雹/.test(weather)) return 'weather-snow';
  if (weather.includes('雨')) return 'weather-rain';
  if (/雾|霾|沙|尘/.test(weather)) return 'weather-haze';
  if (weather === '晴') return 'weather-sun';
  return weather.includes('云') ? 'cloud' : 'weather-overcast';
}

Component({
  options: { styleIsolation: 'apply-shared' },
  data: {
    loading: true, loaded: false, stale: false, expanded: false,
    cityLabel: '选择城市', city: '', locationNote: '', temperature: 0, weatherText: '', weatherIcon: '',
    humidity: 0, windDirection: '', windPower: '', updatedLabel: '', forecastUpdatedLabel: '',
    forecast: Array<z.infer<typeof weatherSchema>['forecast'][number] & { label: string; icon: string }>(),
    cityOpen: false, selectedCityId: '', cityQuery: '', cities: Array<z.infer<typeof weatherLocationSchema>>(),
    cityLoading: false, cityError: '', citySearched: false, cityPage: 0, cityTotal: 0
  },
  lifetimes: {
    attached() {
      requests.set(this, { scope: new RequestScope(), generation: 0, cityGeneration: 0, query: null, fetchedAt: 0 });
      void this.loadWeather();
    },
    detached() {
      requests.get(this)!.scope.close();
      requests.delete(this);
    }
  },
  pageLifetimes: {
    hide() {
      const state = requests.get(this)!;
      state.generation++;
      state.cityGeneration++;
      state.scope.close();
      this.setData({ loading: false, cityLoading: false, cityOpen: false });
    },
    show() {
      const state = requests.get(this)!;
      if (state.scope.active) return;
      state.scope = new RequestScope();
      if (!this.data.loaded || Date.now() - state.fetchedAt >= 600000 || this.data.forecast[0].date !== new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)) void this.loadWeather();
    }
  },
  methods: {
    onRefresh() { if (!this.data.loading) void this.loadWeather(true); },
    onToggleForecast() { this.setData({ expanded: !this.data.expanded }); },
    onOpenCity() { this.setData({ cityOpen: true }); },
    onCloseCity() {
      requests.get(this)!.cityGeneration++;
      this.setData({ cityOpen: false, cityLoading: false });
    },
    onCityQuery(event: WechatMiniprogram.Input) {
      requests.get(this)!.cityGeneration++;
      this.setData({ cityQuery: event.detail.value, cities: [], cityLoading: false, cityError: '', citySearched: false, cityPage: 0, cityTotal: 0 });
    },
    onSearchCities() {
      if (this.data.cityLoading || !this.data.cityQuery.trim()) return;
      this.setData({ cities: [], cityPage: 0, cityTotal: 0 });
      void this.loadCities(1);
    },
    onMoreCities() { if (!this.data.cityLoading) void this.loadCities(this.data.cityPage + 1); },
    onCity(event: WechatMiniprogram.TouchEvent) {
      const city = this.data.cities[z.coerce.number().int().min(0).max(this.data.cities.length - 1).parse(event.currentTarget.dataset.index)];
      const state = requests.get(this)!;
      state.cityGeneration++;
      state.query = { cityCode: city.cityCode };
      this.triggerEvent('citychange');
      this.setData({ cityLabel: city.path, selectedCityId: city.id, cityOpen: false, cityLoading: false, loaded: false, forecast: [] });
      void this.loadWeather();
    },
    async loadCities(page: number) {
      const state = requests.get(this)!;
      const generation = ++state.cityGeneration;
      this.setData({ cityLoading: true, cityError: '' });
      try {
        const result = await searchWeatherLocations(state.scope, this.data.cityQuery.trim(), page);
        if (!state.scope.active || generation !== state.cityGeneration) return;
        this.setData({ cities: page === 1 ? result.data : this.data.cities.concat(result.data), cityPage: page, cityTotal: result.pagination.total, cityLoading: false, citySearched: true });
      } catch (error) {
        const message = errorMessage(error);
        if (state.scope.active && generation === state.cityGeneration && message) this.setData({ cityError: message, cityLoading: false });
      }
    },
    async loadWeather(refresh = false) {
      const state = requests.get(this)!;
      const generation = ++state.generation;
      this.setData({ loading: true });
      if (!state.query) {
        wx.getLocation({
          type: 'gcj02',
          success: result => {
            if (!state.scope.active || generation !== state.generation) return;
            state.query = { latitude: result.latitude, longitude: result.longitude };
            this.setData({ cityLabel: '当前位置' });
            void this.loadWeather(refresh);
          },
          fail: () => {
            if (!state.scope.active || generation !== state.generation) return;
            state.query = { source: 'ip' };
            this.setData({ cityLabel: '自动识别' });
            void this.loadWeather(refresh);
          }
        });
        return;
      }
      const query = state.query;
      try {
        const result = await getWeather(state.scope, query, refresh);
        if (!state.scope.active || generation !== state.generation) return;
        state.fetchedAt = Date.now();
        this.setData({
          loading: false, loaded: true, stale: result.data.stale, city: result.data.city, locationNote: 'source' in query ? ' · 大致位置' : '',
          cityLabel: 'source' in query ? `${result.data.city} · 大致位置` : 'latitude' in query ? `当前位置 · ${result.data.city}` : this.data.cityLabel,
          temperature: result.data.current.temperature, weatherText: result.data.current.weather, weatherIcon: weatherIcon(result.data.current.weather),
          humidity: result.data.current.humidity, windDirection: result.data.current.windDirection.includes('风') ? result.data.current.windDirection : `${result.data.current.windDirection}风`, windPower: result.data.current.windPower,
          updatedLabel: `${result.data.current.updatedAt.slice(5, 10).replace('-', '/')} ${result.data.current.updatedAt.slice(11, 16)}`,
          forecastUpdatedLabel: `${result.data.updatedAt.slice(5, 10).replace('-', '/')} ${result.data.updatedAt.slice(11, 16)}`,
          forecast: result.data.forecast.map((day, index) => ({ ...day, label: ['今天', '明天', '后天'][index], icon: weatherIcon(day.textDay) }))
        });
        this.triggerEvent('weatherchange', { cityCode: result.data.cityCode });
      } catch (error) {
        if (!state.scope.active || generation !== state.generation) return;
        if (error instanceof ApiError && error.code === 'LOCATION_UNAVAILABLE') {
          if ('latitude' in query) {
            state.query = { source: 'ip' };
            this.setData({ cityLabel: '自动识别' });
            void this.loadWeather(refresh);
            return;
          }
          if ('source' in query) {
            state.query = null;
            this.setData({ cityLabel: '选择城市', loading: false, stale: this.data.loaded });
            return;
          }
        }
        this.setData({ loading: false, stale: this.data.loaded });
      }
    }
  }
});
