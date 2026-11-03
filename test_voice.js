// Диагностика голосового подключения: бот сам заходит в первый голосовой
// канал сервера и логирует каждое состояние соединения.
// Запуск: node test_voice.js
require('dotenv').config();
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');
const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
} = require('@discordjs/voice');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async () => {
  console.log(`Вошли как ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch();
    const voice = channels.filter((c) => c && c.type === ChannelType.GuildVoice);
    console.log(`Сервер «${guild.name}», голосовых каналов: ${voice.size}`);
    for (const ch of voice.values()) {
      console.log(`  - ${ch.name} (${ch.id})`);
    }
    const target = voice.first();
    if (!target) continue;

    console.log(`\nПробую подключиться к «${target.name}»...`);
    const connection = joinVoiceChannel({
      channelId: target.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });
    connection.on('stateChange', (o, n) => console.log(`[voice] ${o.status} -> ${n.status}`));
    connection.on('debug', (m) => console.log(`[voice:debug] ${m}`));
    connection.receiver.voiceConnection; // noop
    const net = connection;
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      console.log('УСПЕХ: голосовое соединение установлено!');
      connection.destroy();
      process.exit(0);
    } catch (err) {
      console.log(`НЕУДАЧА: ${err.message}`);
      // Подсветим внутреннее состояние UDP, если доступно
      const networking = connection.state?.networking;
      if (networking?.state) {
        console.log('Внутреннее состояние:', JSON.stringify(networking.state.code ?? networking.state));
      }
      connection.destroy();
      process.exit(1);
    }
  }
  console.log('Голосовых каналов не найдено.');
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
