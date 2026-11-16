import { colors, colorLabels } from '../api/contracts';

export const COLOR_OPTIONS = [3, 6, 5, 1, 4, 0, 2, 7, 8, 9, 10, 11, 12].map(index => ({
  value: colors[index],
  label: colorLabels[index],
  swatch: ['#F5F3EB', '#414940', '#9C9C9C', '#E5D8BC', '#987858', '#668493', '#929D86', '#BD6B65', '#DEAFBA', '#DBC576', '#A595BA', '#CF9B6C', 'linear-gradient(135deg,#E5D8BC,#668493,#929D86)'][index]
}));
